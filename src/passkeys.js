import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ADMIN_USER_ID = new Uint8Array(Buffer.from('eagles-run-club-admin', 'utf8'));

export class PasskeyManager {
  constructor({
    storeFile,
    rpName = 'Eagles Run Club Admin',
    rpID = '',
    expectedOrigins = [],
  } = {}) {
    this.storeFile = storeFile;
    this.rpName = rpName;
    this.configuredRpID = rpID.trim();
    this.configuredOrigins = expectedOrigins.filter(Boolean);
    this.challenges = new Map();
    this.credentials = this._loadCredentials();
  }

  _loadCredentials() {
    if (!this.storeFile) return [];
    try {
      if (!fs.existsSync(this.storeFile)) return [];
      const raw = fs.readFileSync(this.storeFile, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.credentials) ? parsed.credentials : [];
    } catch (err) {
      console.warn(`WARNING: Could not load passkeys from ${this.storeFile}: ${err.message}`);
      return [];
    }
  }

  _saveCredentials() {
    if (!this.storeFile) return;
    const dir = path.dirname(this.storeFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = `${this.storeFile}.tmp`;
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ version: 1, credentials: this.credentials }, null, 2),
      'utf8'
    );
    fs.renameSync(tmpFile, this.storeFile);
  }

  _pruneChallenges(nowMs = Date.now()) {
    for (const [id, entry] of this.challenges.entries()) {
      if (entry.expiresAt <= nowMs) {
        this.challenges.delete(id);
      }
    }
  }

  _createChallengeId(type, challenge, rpID, origin) {
    this._pruneChallenges();
    const challengeId = crypto.randomBytes(24).toString('base64url');
    this.challenges.set(challengeId, {
      type,
      challenge,
      rpID,
      origin,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return challengeId;
  }

  _consumeChallenge(challengeId, expectedType) {
    this._pruneChallenges();
    if (!challengeId || typeof challengeId !== 'string') {
      throw new Error('Missing or expired WebAuthn challenge.');
    }
    const entry = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!entry || entry.type !== expectedType || entry.expiresAt <= Date.now()) {
      throw new Error('WebAuthn challenge expired. Please try again.');
    }
    return entry;
  }

  resolveRpContext(req) {
    const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
      .split(',')[0]
      .trim();
    const hostname = rawHost.replace(/:\d+$/, '').toLowerCase();
    const proto =
      String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() ||
      (hostname === 'localhost' || hostname === '127.0.0.1' ? 'http' : 'https');

    const rpID = this.configuredRpID || hostname;
    const requestOrigin = `${proto}://${rawHost}`;
    const expectedOrigin =
      this.configuredOrigins.length > 0 ? this.configuredOrigins : [requestOrigin];

    return { rpID, origin: requestOrigin, expectedOrigin };
  }

  hasPasskeys() {
    return this.credentials.length > 0;
  }

  listPublicPasskeys() {
    return this.credentials.map((c) => ({
      id: c.id,
      label: c.label,
      deviceType: c.deviceType || 'singleDevice',
      backedUp: Boolean(c.backedUp),
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt || null,
    }));
  }

  async createRegistrationOptions(req) {
    const { rpID, origin } = this.resolveRpContext(req);
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID,
      userID: ADMIN_USER_ID,
      userName: 'admin@eaglesrunclub',
      userDisplayName: 'Eagles Run Club Admin',
      attestationType: 'none',
      excludeCredentials: this.credentials.map((c) => ({
        id: c.id,
        transports: c.transports,
      })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });

    const challengeId = this._createChallengeId('register', options.challenge, rpID, origin);
    return { challengeId, options };
  }

  async verifyRegistration(req, { challengeId, response, label }) {
    const entry = this._consumeChallenge(challengeId, 'register');
    const { expectedOrigin } = this.resolveRpContext(req);
    const origins = Array.from(new Set([...expectedOrigin, entry.origin]));

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin: origins,
      expectedRPID: entry.rpID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('Passkey registration could not be verified.');
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const cleanLabel =
      typeof label === 'string' && label.trim()
        ? label.trim().slice(0, 60)
        : `Device ${this.credentials.length + 1}`;

    const existingIdx = this.credentials.findIndex((c) => c.id === credential.id);
    const record = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports || [],
      deviceType: credentialDeviceType,
      backedUp: Boolean(credentialBackedUp),
      label: cleanLabel,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      this.credentials[existingIdx] = record;
    } else {
      this.credentials.push(record);
    }
    this._saveCredentials();

    return {
      id: record.id,
      label: record.label,
      createdAt: record.createdAt,
    };
  }

  async createAuthenticationOptions(req) {
    if (!this.hasPasskeys()) {
      throw new Error('No passkeys registered yet.');
    }
    const { rpID, origin } = this.resolveRpContext(req);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: this.credentials.map((c) => ({
        id: c.id,
        transports: c.transports,
      })),
      userVerification: 'required',
    });

    const challengeId = this._createChallengeId('login', options.challenge, rpID, origin);
    return { challengeId, options };
  }

  async verifyAuthentication(req, { challengeId, response }) {
    const entry = this._consumeChallenge(challengeId, 'login');
    const credId = response?.id;
    const record = this.credentials.find((c) => c.id === credId);
    if (!record) {
      throw new Error('Passkey not recognized on this server.');
    }

    const { expectedOrigin } = this.resolveRpContext(req);
    const origins = Array.from(new Set([...expectedOrigin, entry.origin]));

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin: origins,
      expectedRPID: entry.rpID,
      requireUserVerification: true,
      credential: {
        id: record.id,
        publicKey: new Uint8Array(Buffer.from(record.publicKey, 'base64url')),
        counter: record.counter,
        transports: record.transports,
      },
    });

    if (!verification.verified) {
      throw new Error('Biometric verification failed.');
    }

    record.counter = verification.authenticationInfo.newCounter;
    record.lastUsedAt = new Date().toISOString();
    this._saveCredentials();

    return {
      id: record.id,
      label: record.label,
    };
  }
}
