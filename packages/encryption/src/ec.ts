import { Buffer } from '@stacks/common';
import { ec as EllipticCurve } from 'elliptic';
import * as BN from 'bn.js';
import { randomBytes } from './cryptoRandom';
import { FailedDecryptionError } from '@stacks/common';
import { getPublicKeyFromPrivate } from './keys';
import { hashSha256Sync, hashSha512Sync } from './sha2Hash';
import { createHmacSha256 } from './hmacSha256';
import { createCipher } from './aesCipher';
import { getAesCbcOutputLength, getBase64OutputLength } from './utils';

const ecurve = new EllipticCurve('secp256k1');

/**
 * Controls how the encrypted data buffer will be encoded as a string in the JSON payload.
 * Options:
 *    `hex` -- the legacy default, file size increase 100% (2x).
 *    `base64` -- file size increased ~33%.
 * @ignore
 */
export type CipherTextEncoding = 'hex' | 'base64';

/**
 * @ignore
 */
export type CipherObject = {
  iv: string;
  ephemeralPK: string;
  cipherText: string;
  /** If undefined then hex encoding is used for the `cipherText` string. */
  cipherTextEncoding?: CipherTextEncoding;
  mac: string;
  wasString: boolean;
};

/**
 * @ignore
 */
export type SignedCipherObject = {
  /** Hex encoded DER signature (up to 144 chars) */
  signature: string;
  /** Hex encoded public key (66 char length) */
  publicKey: string;
  /** The stringified json of a `CipherObject` */
  cipherText: string;
};

/**
 * @ignore
 */
export async function aes256CbcEncrypt(
  iv: Buffer,
  key: Buffer,
  plaintext: Buffer
): Promise<Buffer> {
  const cipher = await createCipher();
  const result = await cipher.encrypt('aes-256-cbc', key, iv, plaintext);
  return result;
}

/**
 * @ignore
 */
async function aes256CbcDecrypt(iv: Buffer, key: Buffer, ciphertext: Buffer): Promise<Buffer> {
  const cipher = await createCipher();
  const result = await cipher.decrypt('aes-256-cbc', key, iv, ciphertext);
  return result;
}

/**
 * @ignore
 */
async function hmacSha256(key: Buffer, content: Buffer) {
  const hmacSha256 = await createHmacSha256();
  return hmacSha256.digest(key, content);
}

/**
 * @ignore
 */
function equalConstTime(b1: Buffer, b2: Buffer) {
  if (b1.length !== b2.length) {
    return false;
  }
  let res = 0;
  for (let i = 0; i < b1.length; i++) {
    res |= b1[i] ^ b2[i]; // jshint ignore:line
  }
  return res === 0;
}

/**
 * @ignore
 */
function sharedSecretToKeys(sharedSecret: Buffer): { encryptionKey: Buffer; hmacKey: Buffer } {
  // generate mac and encryption key from shared secret
  const hashedSecret = hashSha512Sync(sharedSecret);
  return {
    encryptionKey: hashedSecret.slice(0, 32),
    hmacKey: hashedSecret.slice(32),
  };
}

/**
 * Hex encodes a 32-byte BN.js instance.
 * The result string is zero padded and always 64 characters in length.
 * @ignore
 */
export function getHexFromBN(bnInput: BN): string {
  const hexOut = bnInput.toString('hex', 64);
  if (hexOut.length === 64) {
    return hexOut;
  } else if (hexOut.length < 64) {
    // pad with leading zeros
    // the padStart function would require node 9
    const padding = '0'.repeat(64 - hexOut.length);
    return `${padding}${hexOut}`;
  } else {
    throw new Error('Generated a > 32-byte BN for encryption. Failing.');
  }
}

/**
 * Returns a big-endian encoded 32-byte BN.js instance.
 * The result Buffer is zero padded and always 32 bytes in length.
 * @ignore
 */
export function getBufferFromBN(bnInput: BN): Buffer {
  const result = bnInput.toArrayLike(Buffer, 'be', 32);
  if (result.byteLength !== 32) {
    throw new Error('Failed to generate a 32-byte BN');
  }
  return result;
}

/**
 * Get details about the JSON envelope size overhead for ciphertext payloads.
 * @ignore
 */
export function getCipherObjectWrapper(opts: {
  wasString: boolean;
  cipherTextEncoding: CipherTextEncoding;
}): {
  /** The stringified JSON string of an empty `CipherObject`. */
  payloadShell: string;
  /** Total string length of all the `CipherObject` values that always have constant lengths. */
  payloadValuesLength: number;
} {
  // Placeholder structure of the ciphertext payload, used to determine the
  // stringified JSON overhead length.
  const shell: CipherObject = {
    iv: '',
    ephemeralPK: '',
    mac: '',
    cipherText: '',
    wasString: !!opts.wasString,
  };
  if (opts.cipherTextEncoding === 'base64') {
    shell.cipherTextEncoding = 'base64';
  }
  // Hex encoded 16 byte buffer.
  const ivLength = 32;
  // Hex encoded, compressed EC pubkey of 33 bytes.
  const ephemeralPKLength = 66;
  // Hex encoded 32 byte hmac-sha256.
  const macLength = 64;
  return {
    payloadValuesLength: ivLength + ephemeralPKLength + macLength,
    payloadShell: JSON.stringify(shell),
  };
}

/**
 * Get details about the JSON envelope size overhead for signed ciphertext payloads.
 * @param payloadShell - The JSON stringified empty `CipherObject`
 * @ignore
 */
export function getSignedCipherObjectWrapper(payloadShell: string): {
  /** The stringified JSON string of an empty `SignedCipherObject`. */
  signedPayloadValuesLength: number;
  /** Total string length of all the `SignedCipherObject` values
   * that always have constant lengths */
  signedPayloadShell: string;
} {
  // Placeholder structure of the signed ciphertext payload, used to determine the
  // stringified JSON overhead length.
  const shell: SignedCipherObject = {
    signature: '',
    publicKey: '',
    cipherText: payloadShell,
  };
  // Hex encoded DER signature, up to 72 byte length.
  const signatureLength = 144;
  // Hex encoded 33 byte public key.
  const publicKeyLength = 66;
  return {
    signedPayloadValuesLength: signatureLength + publicKeyLength,
    signedPayloadShell: JSON.stringify(shell),
  };
}

/**
 * Fast function that determines the final ASCII string byte length of the
 * JSON stringified ECIES encrypted payload.
 * @ignore
 */
export function eciesGetJsonStringLength(opts: {
  contentLength: number;
  wasString: boolean;
  sign: boolean;
  cipherTextEncoding: CipherTextEncoding;
}): number {
  const { payloadShell, payloadValuesLength } = getCipherObjectWrapper(opts);

  // Calculate the AES output length given the input length.
  const cipherTextLength = getAesCbcOutputLength(opts.contentLength);

  // Get the encoded string length of the cipherText.
  let encodedCipherTextLength: number;
  if (!opts.cipherTextEncoding || opts.cipherTextEncoding === 'hex') {
    encodedCipherTextLength = cipherTextLength * 2;
  } else if (opts.cipherTextEncoding === 'base64') {
    encodedCipherTextLength = getBase64OutputLength(cipherTextLength);
  } else {
    throw new Error(`Unexpected cipherTextEncoding "${opts.cipherTextEncoding}"`);
  }

  if (!opts.sign) {
    // Add the length of the JSON envelope, ciphertext length, and length of const values.
    return payloadShell.length + payloadValuesLength + encodedCipherTextLength;
  } else {
    // Get the signed version of the JSON envelope
    const { signedPayloadShell, signedPayloadValuesLength } =
      getSignedCipherObjectWrapper(payloadShell);
    // Add length of the JSON envelope, ciphertext length, and length of the const values.
    return (
      signedPayloadShell.length +
      signedPayloadValuesLength +
      payloadValuesLength +
      encodedCipherTextLength
    );
  }
}

/**
 * Encrypt content to elliptic curve publicKey using ECIES
 * @param publicKey - secp256k1 public key hex string
 * @param content - content to encrypt
 * @return Object containing:
 *  iv (initialization vector, hex encoding),
 *  cipherText (cipher text either hex or base64 encoded),
 *  mac (message authentication code, hex encoded),
 *  ephemeral public key (hex encoded),
 *  wasString (boolean indicating with or not to return a buffer or string on decrypt)
 * @private
 * @ignore
 */
export async function encryptECIES(
  publicKey: string,
  content: Buffer,
  wasString: boolean,
  cipherTextEncoding?: CipherTextEncoding
): Promise<CipherObject> {
  const ecPK = ecurve.keyFromPublic(publicKey, 'hex').getPublic();
  const ephemeralSK = ecurve.genKeyPair();
  const ephemeralPK = Buffer.from(ephemeralSK.getPublic().encodeCompressed());
  const sharedSecret = ephemeralSK.derive(ecPK) as BN;
  const sharedSecretBuffer = getBufferFromBN(sharedSecret);
  const sharedKeys = sharedSecretToKeys(sharedSecretBuffer);

  const initializationVector = randomBytes(16);

  const cipherText = await aes256CbcEncrypt(
    initializationVector,
    sharedKeys.encryptionKey,
    content
  );

  const macData = Buffer.concat([initializationVector, ephemeralPK, cipherText]);
  const mac = await hmacSha256(sharedKeys.hmacKey, macData);

  let cipherTextString: string;
  if (!cipherTextEncoding || cipherTextEncoding === 'hex') {
    cipherTextString = cipherText.toString('hex');
  } else if (cipherTextEncoding === 'base64') {
    cipherTextString = cipherText.toString('base64');
  } else {
    throw new Error(`Unexpected cipherTextEncoding "${cipherTextEncoding}"`);
  }

  const result: CipherObject = {
    iv: initializationVector.toString('hex'),
    ephemeralPK: ephemeralPK.toString('hex'),
    cipherText: cipherTextString,
    mac: mac.toString('hex'),
    wasString: !!wasString,
  };
  if (cipherTextEncoding && cipherTextEncoding !== 'hex') {
    result.cipherTextEncoding = cipherTextEncoding;
  }
  return result;
}

/**
 * Decrypt content encrypted using ECIES
 * @param {String} privateKey - secp256k1 private key hex string
 * @param {Object} cipherObject - object to decrypt, should contain:
 *  iv (initialization vector), cipherText (cipher text),
 *  mac (message authentication code), ephemeralPublicKey
 *  wasString (boolean indicating with or not to return a buffer or string on decrypt)
 * @return {Buffer} plaintext
 * @throws {FailedDecryptionError} if unable to decrypt
 * @private
 * @ignore
 */
export async function decryptECIES(
  privateKey: string,
  cipherObject: CipherObject
): Promise<Buffer | string> {
  const ecSK = ecurve.keyFromPrivate(privateKey, 'hex');
  let ephemeralPK = null;
  try {
    ephemeralPK = ecurve.keyFromPublic(cipherObject.ephemeralPK, 'hex').getPublic();
  } catch (error) {
    throw new FailedDecryptionError(
      'Unable to get public key from cipher object. ' +
        'You might be trying to decrypt an unencrypted object.'
    );
  }

  const sharedSecret = ecSK.derive(ephemeralPK) as BN;
  const sharedSecretBuffer = getBufferFromBN(sharedSecret);

  const sharedKeys = sharedSecretToKeys(sharedSecretBuffer);

  const ivBuffer = Buffer.from(cipherObject.iv, 'hex');
  let cipherTextBuffer: Buffer;

  if (!cipherObject.cipherTextEncoding || cipherObject.cipherTextEncoding === 'hex') {
    cipherTextBuffer = Buffer.from(cipherObject.cipherText, 'hex');
  } else if (cipherObject.cipherTextEncoding === 'base64') {
    cipherTextBuffer = Buffer.from(cipherObject.cipherText, 'base64');
  } else {
    throw new Error(`Unexpected cipherTextEncoding "${cipherObject.cipherText}"`);
  }

  const macData = Buffer.concat([
    ivBuffer,
    Buffer.from(ephemeralPK.encodeCompressed()),
    cipherTextBuffer,
  ]);
  const actualMac = await hmacSha256(sharedKeys.hmacKey, macData);
  const expectedMac = Buffer.from(cipherObject.mac, 'hex');
  if (!equalConstTime(expectedMac, actualMac)) {
    throw new FailedDecryptionError('Decryption failed: failure in MAC check');
  }
  const plainText = await aes256CbcDecrypt(ivBuffer, sharedKeys.encryptionKey, cipherTextBuffer);

  if (cipherObject.wasString) {
    return plainText.toString();
  } else {
    return plainText;
  }
}

/**
 * Sign content using ECDSA
 *
 * @param {String} privateKey - secp256k1 private key hex string
 * @param {Object} content - content to sign
 * @return {Object} contains:
 * signature - Hex encoded DER signature
 * public key - Hex encoded private string taken from privateKey
 * @private
 * @ignore
 */
export function signECDSA(
  privateKey: string,
  content: string | Buffer
): {
  publicKey: string;
  signature: string;
} {
  const contentBuffer = content instanceof Buffer ? content : Buffer.from(content);
  const ecPrivate = ecurve.keyFromPrivate(privateKey, 'hex');
  const publicKey = getPublicKeyFromPrivate(privateKey);
  const contentHash = hashSha256Sync(contentBuffer);
  const signature = ecPrivate.sign(contentHash);
  const signatureString: string = signature.toDER('hex');
  return {
    signature: signatureString,
    publicKey,
  };
}

/**
 * @ignore
 */
function getBuffer(content: string | ArrayBuffer | Buffer) {
  if (content instanceof Buffer) return content;
  else if (content instanceof ArrayBuffer) return Buffer.from(content);
  else return Buffer.from(content);
}

/**
 * Verify content using ECDSA
 * @param {String | Buffer} content - Content to verify was signed
 * @param {String} publicKey - secp256k1 private key hex string
 * @param {String} signature - Hex encoded DER signature
 * @return {Boolean} returns true when signature matches publickey + content, false if not
 * @private
 * @ignore
 */
export function verifyECDSA(
  content: string | ArrayBuffer | Buffer,
  publicKey: string,
  signature: string
): boolean {
  const contentBuffer = getBuffer(content);
  const ecPublic = ecurve.keyFromPublic(publicKey, 'hex');
  const contentHash = hashSha256Sync(contentBuffer);

  return ecPublic.verify(contentHash, <any>signature);
}
