import { Buffer } from '@stacks/common';
import {
  AddressHashMode,
  AuthType,
  MultiSigHashMode,
  PubKeyEncoding,
  RECOVERABLE_ECDSA_SIG_LENGTH_BYTES,
  SingleSigHashMode,
  StacksMessageType,
} from './constants';

import { BufferArray, cloneDeep, leftPadHex, txidFromData } from './utils';

import {
  addressFromPublicKeys,
  createEmptyAddress,
  createLPList,
  deserializeLPList,
  serializeLPList,
} from './types';

import {
  compressPublicKey,
  createStacksPublicKey,
  deserializePublicKey,
  getPublicKey,
  isCompressed,
  publicKeyFromSignature,
  serializePublicKey,
  signWithKey,
  StacksPrivateKey,
  StacksPublicKey,
} from './keys';

import BigNum from 'bn.js';
import { BufferReader } from './bufferReader';
import {
  DeserializationError,
  SerializationError,
  SigningError,
  VerificationError,
} from './errors';

abstract class Deserializable {
  abstract serialize(): Buffer;
  abstract deserialize(bufferReader: BufferReader): void;
  static deserialize<T extends Deserializable>(this: new () => T, bufferReader: BufferReader): T {
    const message = new this();
    message.deserialize(bufferReader);
    return message;
  }
}

export interface MessageSignature {
  readonly type: StacksMessageType.MessageSignature;
  data: string;
}

export function createMessageSignature(signature: string): MessageSignature {
  const length = Buffer.from(signature, 'hex').byteLength;
  if (length != RECOVERABLE_ECDSA_SIG_LENGTH_BYTES) {
    throw Error('Invalid signature');
  }

  return {
    type: StacksMessageType.MessageSignature,
    data: signature,
  };
}

export function emptyMessageSignature(): MessageSignature {
  return {
    type: StacksMessageType.MessageSignature,
    data: Buffer.alloc(RECOVERABLE_ECDSA_SIG_LENGTH_BYTES, 0x00).toString('hex'),
  };
}

export function serializeMessageSignature(messageSignature: MessageSignature): Buffer {
  const bufferArray: BufferArray = new BufferArray();
  bufferArray.appendHexString(messageSignature.data);
  return bufferArray.concatBuffer();
}

export function deserializeMessageSignature(bufferReader: BufferReader): MessageSignature {
  return createMessageSignature(
    bufferReader.readBuffer(RECOVERABLE_ECDSA_SIG_LENGTH_BYTES).toString('hex')
  );
}

enum AuthFieldType {
  PublicKeyCompressed = 0x00,
  PublicKeyUncompressed = 0x01,
  SignatureCompressed = 0x02,
  SignatureUncompressed = 0x03,
}

export type TransactionAuthFieldContents = StacksPublicKey | MessageSignature;

export interface TransactionAuthField {
  type: StacksMessageType.TransactionAuthField;
  pubKeyEncoding: PubKeyEncoding;
  contents: TransactionAuthFieldContents;
}

export function createTransactionAuthField(
  pubKeyEncoding: PubKeyEncoding,
  contents: TransactionAuthFieldContents
): TransactionAuthField {
  return {
    pubKeyEncoding,
    type: StacksMessageType.TransactionAuthField,
    contents,
  };
}

export function serializeTransactionAuthField(field: TransactionAuthField): Buffer {
  const bufferArray: BufferArray = new BufferArray();

  switch (field.contents.type) {
    case StacksMessageType.PublicKey:
      if (field.pubKeyEncoding == PubKeyEncoding.Compressed) {
        bufferArray.appendByte(AuthFieldType.PublicKeyCompressed);
        bufferArray.push(serializePublicKey(field.contents));
      } else {
        bufferArray.appendByte(AuthFieldType.PublicKeyUncompressed);
        bufferArray.push(serializePublicKey(compressPublicKey(field.contents.data)));
      }
      break;
    case StacksMessageType.MessageSignature:
      if (field.pubKeyEncoding == PubKeyEncoding.Compressed) {
        bufferArray.appendByte(AuthFieldType.SignatureCompressed);
      } else {
        bufferArray.appendByte(AuthFieldType.SignatureUncompressed);
      }
      bufferArray.push(serializeMessageSignature(field.contents));
      break;
  }

  return bufferArray.concatBuffer();
}

export function deserializeTransactionAuthField(bufferReader: BufferReader): TransactionAuthField {
  const authFieldType = bufferReader.readUInt8Enum(AuthFieldType, n => {
    throw new DeserializationError(`Could not read ${n} as AuthFieldType`);
  });

  switch (authFieldType) {
    case AuthFieldType.PublicKeyCompressed:
      return createTransactionAuthField(
        PubKeyEncoding.Compressed,
        deserializePublicKey(bufferReader)
      );
    case AuthFieldType.PublicKeyUncompressed:
      return createTransactionAuthField(
        PubKeyEncoding.Uncompressed,
        deserializePublicKey(bufferReader)
      );
    case AuthFieldType.SignatureCompressed:
      return createTransactionAuthField(
        PubKeyEncoding.Compressed,
        deserializeMessageSignature(bufferReader)
      );
    case AuthFieldType.SignatureUncompressed:
      return createTransactionAuthField(
        PubKeyEncoding.Uncompressed,
        deserializeMessageSignature(bufferReader)
      );
    default:
      throw new Error(`Unknown auth field type: ${JSON.stringify(authFieldType)}`);
  }
}

export interface SingleSigSpendingCondition {
  hashMode: SingleSigHashMode;
  signer: string;
  nonce: BigNum;
  fee: BigNum;
  keyEncoding: PubKeyEncoding;
  signature: MessageSignature;
}

export interface MultiSigSpendingCondition {
  hashMode: MultiSigHashMode;
  signer: string;
  nonce: BigNum;
  fee: BigNum;
  fields: TransactionAuthField[];
  signaturesRequired: number;
}

export type SpendingCondition = SingleSigSpendingCondition | MultiSigSpendingCondition;

export function createSingleSigSpendingCondition(
  hashMode: SingleSigHashMode,
  pubKey: string,
  nonce: BigNum,
  fee: BigNum
): SingleSigSpendingCondition {
  // address version arg doesn't matter for signer hash generation
  const signer = addressFromPublicKeys(0, hashMode, 1, [createStacksPublicKey(pubKey)]).hash160;
  const keyEncoding = isCompressed(createStacksPublicKey(pubKey))
    ? PubKeyEncoding.Compressed
    : PubKeyEncoding.Uncompressed;

  return {
    hashMode,
    signer,
    nonce,
    fee,
    keyEncoding,
    signature: emptyMessageSignature(),
  };
}

export function createMultiSigSpendingCondition(
  hashMode: MultiSigHashMode,
  numSigs: number,
  pubKeys: string[],
  nonce: BigNum,
  fee: BigNum
): MultiSigSpendingCondition {
  const stacksPublicKeys = pubKeys.map(createStacksPublicKey);

  // address version arg doesn't matter for signer hash generation
  const signer = addressFromPublicKeys(0, hashMode, numSigs, stacksPublicKeys).hash160;

  return {
    hashMode,
    signer,
    nonce,
    fee,
    fields: [],
    signaturesRequired: numSigs,
  };
}

export function isSingleSig(condition: SpendingCondition): condition is SingleSigSpendingCondition {
  return 'signature' in condition;
}

function clearCondition(condition: SpendingCondition): SpendingCondition {
  const cloned = cloneDeep(condition);
  cloned.nonce = new BigNum(0);
  cloned.fee = new BigNum(0);

  if (isSingleSig(cloned)) {
    cloned.signature = emptyMessageSignature();
  } else {
    cloned.fields = [];
  }

  return cloned;
}

export function serializeSingleSigSpendingCondition(condition: SingleSigSpendingCondition): Buffer {
  const bufferArray: BufferArray = new BufferArray();
  bufferArray.appendByte(condition.hashMode);
  bufferArray.appendHexString(condition.signer);
  bufferArray.push(condition.nonce.toArrayLike(Buffer, 'be', 8));
  bufferArray.push(condition.fee.toArrayLike(Buffer, 'be', 8));
  bufferArray.appendByte(condition.keyEncoding);
  bufferArray.push(serializeMessageSignature(condition.signature));
  return bufferArray.concatBuffer();
}

export function serializeMultiSigSpendingCondition(condition: MultiSigSpendingCondition): Buffer {
  const bufferArray: BufferArray = new BufferArray();
  bufferArray.appendByte(condition.hashMode);
  bufferArray.appendHexString(condition.signer);
  bufferArray.push(condition.nonce.toArrayLike(Buffer, 'be', 8));
  bufferArray.push(condition.fee.toArrayLike(Buffer, 'be', 8));

  const fields = createLPList(condition.fields);
  bufferArray.push(serializeLPList(fields));

  const numSigs = Buffer.alloc(2);
  numSigs.writeUInt16BE(condition.signaturesRequired, 0);
  bufferArray.push(numSigs);
  return bufferArray.concatBuffer();
}

export function deserializeSingleSigSpendingCondition(
  hashMode: SingleSigHashMode,
  bufferReader: BufferReader
): SingleSigSpendingCondition {
  const signer = bufferReader.readBuffer(20).toString('hex');
  const nonce = new BigNum(bufferReader.readBuffer(8).toString('hex'), 16);
  const fee = new BigNum(bufferReader.readBuffer(8).toString('hex'), 16);

  const keyEncoding = bufferReader.readUInt8Enum(PubKeyEncoding, n => {
    throw new DeserializationError(`Could not parse ${n} as PubKeyEncoding`);
  });
  const signature = deserializeMessageSignature(bufferReader);
  return {
    hashMode,
    signer,
    nonce,
    fee,
    keyEncoding,
    signature,
  };
}

export function deserializeMultiSigSpendingCondition(
  hashMode: MultiSigHashMode,
  bufferReader: BufferReader
): MultiSigSpendingCondition {
  const signer = bufferReader.readBuffer(20).toString('hex');
  const nonce = new BigNum(bufferReader.readBuffer(8).toString('hex'), 16);
  const fee = new BigNum(bufferReader.readBuffer(8).toString('hex'), 16);

  const fields = deserializeLPList(bufferReader, StacksMessageType.TransactionAuthField)
    .values as TransactionAuthField[];

  const signaturesRequired = bufferReader.readUInt16BE();

  return {
    hashMode,
    signer,
    nonce,
    fee,
    fields,
    signaturesRequired,
  };
}

export function serializeSpendingCondition(condition: SpendingCondition): Buffer {
  if (isSingleSig(condition)) {
    return serializeSingleSigSpendingCondition(condition);
  } else {
    return serializeMultiSigSpendingCondition(condition);
  }
}

export function deserializeSpendingCondition(bufferReader: BufferReader): SpendingCondition {
  const hashMode = bufferReader.readUInt8Enum(AddressHashMode, n => {
    throw new DeserializationError(`Could not parse ${n} as AddressHashMode`);
  });

  if (hashMode === AddressHashMode.SerializeP2PKH || hashMode === AddressHashMode.SerializeP2WPKH) {
    return deserializeSingleSigSpendingCondition(hashMode, bufferReader);
  } else {
    return deserializeMultiSigSpendingCondition(hashMode, bufferReader);
  }
}

export function makeSigHashPreSign(
  curSigHash: string,
  authType: AuthType,
  fee: BigNum,
  nonce: BigNum
): string {
  // new hash combines the previous hash and all the new data this signature will add. This
  // includes:
  // * the previous hash
  // * the auth flag
  // * the tx fee (big-endian 8-byte number)
  // * nonce (big-endian 8-byte number)
  const hashLength = 32 + 1 + 8 + 8;

  const sigHash =
    curSigHash +
    Buffer.from([authType]).toString('hex') +
    fee.toArrayLike(Buffer, 'be', 8).toString('hex') +
    nonce.toArrayLike(Buffer, 'be', 8).toString('hex');

  if (Buffer.from(sigHash, 'hex').byteLength !== hashLength) {
    throw Error('Invalid signature hash length');
  }

  return txidFromData(Buffer.from(sigHash, 'hex'));
}

function makeSigHashPostSign(
  curSigHash: string,
  pubKey: StacksPublicKey,
  signature: MessageSignature
): string {
  // new hash combines the previous hash and all the new data this signature will add.  This
  // includes:
  // * the public key compression flag
  // * the signature
  const hashLength = 32 + 1 + RECOVERABLE_ECDSA_SIG_LENGTH_BYTES;

  const pubKeyEncoding = isCompressed(pubKey)
    ? PubKeyEncoding.Compressed
    : PubKeyEncoding.Uncompressed;

  const sigHash = curSigHash + leftPadHex(pubKeyEncoding.toString(16)) + signature.data;

  const sigHashBuffer = Buffer.from(sigHash, 'hex');
  if (sigHashBuffer.byteLength > hashLength) {
    throw Error('Invalid signature hash length');
  }

  return txidFromData(sigHashBuffer);
}

export function nextSignature(
  curSigHash: string,
  authType: AuthType,
  fee: BigNum,
  nonce: BigNum,
  privateKey: StacksPrivateKey
): {
  nextSig: MessageSignature;
  nextSigHash: string;
} {
  const sigHashPreSign = makeSigHashPreSign(curSigHash, authType, fee, nonce);

  const signature = signWithKey(privateKey, sigHashPreSign);
  const publicKey = getPublicKey(privateKey);
  const nextSigHash = makeSigHashPostSign(sigHashPreSign, publicKey, signature);

  return {
    nextSig: signature,
    nextSigHash,
  };
}

export function nextVerification(
  initialSigHash: string,
  authType: AuthType,
  fee: BigNum,
  nonce: BigNum,
  // @ts-ignore
  pubKeyEncoding: PubKeyEncoding,
  signature: MessageSignature
) {
  const sigHashPreSign = makeSigHashPreSign(initialSigHash, authType, fee, nonce);

  const publicKey = createStacksPublicKey(
    publicKeyFromSignature(sigHashPreSign, signature, pubKeyEncoding)
  );

  const nextSigHash = makeSigHashPostSign(sigHashPreSign, publicKey, signature);

  return {
    pubKey: publicKey,
    nextSigHash,
  };
}

function newInitialSigHash(): SpendingCondition {
  const spendingCondition = createSingleSigSpendingCondition(
    AddressHashMode.SerializeP2PKH,
    '',
    new BigNum(0),
    new BigNum(0)
  );
  spendingCondition.signer = createEmptyAddress().hash160;
  spendingCondition.keyEncoding = PubKeyEncoding.Compressed;
  spendingCondition.signature = emptyMessageSignature();
  return spendingCondition;
}

function verify(condition: SpendingCondition, initialSigHash: string, authType: AuthType): string {
  if (isSingleSig(condition)) {
    return verifySingleSig(condition, initialSigHash, authType);
  } else {
    // TODO: verify multisig
    return '';
  }
}

function verifySingleSig(
  condition: SingleSigSpendingCondition,
  initialSigHash: string,
  authType: AuthType
): string {
  const { pubKey, nextSigHash } = nextVerification(
    initialSigHash,
    authType,
    condition.fee,
    condition.nonce,
    condition.keyEncoding,
    condition.signature
  );

  // address version arg doesn't matter for signer hash generation
  const addrBytes = addressFromPublicKeys(0, condition.hashMode, 1, [pubKey]).hash160;

  if (addrBytes !== condition.signer)
    throw new VerificationError(
      `Signer hash does not equal hash of public key(s): ${addrBytes} != ${condition.signer}`
    );

  return nextSigHash;
}

export class Authorization extends Deserializable {
  authType?: AuthType;
  spendingCondition?: SpendingCondition;
  sponsorSpendingCondition?: SpendingCondition;

  constructor(
    authType?: AuthType,
    spendingConditions?: SpendingCondition,
    sponsorSpendingCondition?: SpendingCondition
  ) {
    super();
    this.authType = authType;
    this.spendingCondition = spendingConditions;
    this.sponsorSpendingCondition = sponsorSpendingCondition;
  }

  intoInitialSighashAuth(): Authorization {
    if (this.spendingCondition) {
      switch (this.authType) {
        case AuthType.Standard:
          return new Authorization(AuthType.Standard, clearCondition(this.spendingCondition));
        case AuthType.Sponsored:
          return new Authorization(
            AuthType.Sponsored,
            clearCondition(this.spendingCondition),
            newInitialSigHash()
          );
        default:
          throw new SigningError('Unexpected authorization type for signing');
      }
    }

    throw new Error('Authorization missing SpendingCondition');
  }

  setFee(amount: BigNum) {
    switch (this.authType) {
      case AuthType.Standard:
        this.spendingCondition!.fee = amount;
        break;
      case AuthType.Sponsored:
        this.sponsorSpendingCondition!.fee = amount;
        break;
    }
  }

  getFee() {
    switch (this.authType) {
      case AuthType.Standard:
        return this.spendingCondition!.fee;
      case AuthType.Sponsored:
        return this.sponsorSpendingCondition!.fee;
      default:
        return 0;
    }
  }

  setNonce(nonce: BigNum) {
    this.spendingCondition!.nonce = nonce;
  }

  setSponsorNonce(nonce: BigNum) {
    this.sponsorSpendingCondition!.nonce = nonce;
  }

  setSponsor(sponsorSpendingCondition: SpendingCondition) {
    this.sponsorSpendingCondition = sponsorSpendingCondition;
  }

  verifyOrigin(initialSigHash: string): string {
    switch (this.authType) {
      case AuthType.Standard:
        return verify(this.spendingCondition!, initialSigHash, AuthType.Standard);
      case AuthType.Sponsored:
        return verify(this.spendingCondition!, initialSigHash, AuthType.Standard);
      default:
        throw new SigningError('Invalid origin auth type');
    }
  }

  serialize(): Buffer {
    const bufferArray: BufferArray = new BufferArray();
    if (this.authType === undefined) {
      throw new SerializationError('"authType" is undefined');
    }
    bufferArray.appendByte(this.authType);

    switch (this.authType) {
      case AuthType.Standard:
        if (this.spendingCondition === undefined) {
          throw new SerializationError('"spendingCondition" is undefined');
        }
        bufferArray.push(serializeSpendingCondition(this.spendingCondition));
        break;
      case AuthType.Sponsored:
        if (this.spendingCondition === undefined) {
          throw new SerializationError('"spendingCondition" is undefined');
        }
        if (this.sponsorSpendingCondition === undefined) {
          throw new SerializationError('"spendingCondition" is undefined');
        }
        bufferArray.push(serializeSpendingCondition(this.spendingCondition));
        bufferArray.push(serializeSpendingCondition(this.sponsorSpendingCondition));
        break;
      default:
        throw new SerializationError(
          `Unexpected transaction AuthType while serializing: ${JSON.stringify(this.authType)}`
        );
    }

    return bufferArray.concatBuffer();
  }

  deserialize(bufferReader: BufferReader) {
    this.authType = bufferReader.readUInt8Enum(AuthType, n => {
      throw new DeserializationError(`Could not parse ${n} as AuthType`);
    });

    switch (this.authType) {
      case AuthType.Standard:
        this.spendingCondition = deserializeSpendingCondition(bufferReader);
        break;
      case AuthType.Sponsored:
        this.spendingCondition = deserializeSpendingCondition(bufferReader);
        this.sponsorSpendingCondition = deserializeSpendingCondition(bufferReader);
        break;
      // throw new DeserializationError('Not yet implemented: deserializing sponsored transactions');
      default:
        throw new DeserializationError(
          `Unexpected transaction AuthType while deserializing: ${JSON.stringify(this.authType)}`
        );
    }
  }
}

export class StandardAuthorization extends Authorization {
  constructor(spendingCondition: SpendingCondition) {
    super(AuthType.Standard, spendingCondition);
  }
}

export class SponsoredAuthorization extends Authorization {
  constructor(
    originSpendingCondition: SpendingCondition,
    sponsorSpendingCondition?: SpendingCondition
  ) {
    let sponsorSC = sponsorSpendingCondition;
    if (!sponsorSC) {
      sponsorSC = createSingleSigSpendingCondition(
        AddressHashMode.SerializeP2PKH,
        '0'.repeat(66),
        new BigNum(0),
        new BigNum(0)
      );
    }
    super(AuthType.Sponsored, originSpendingCondition, sponsorSC);
  }
}
