import { Buffer, IntegerType, intToBigInt } from '@stacks/common';
import { StacksTransaction } from './transaction';

import { StacksNetwork, StacksMainnet, StacksTestnet } from '@stacks/network';

import {
  createTokenTransferPayload,
  createSmartContractPayload,
  createContractCallPayload,
} from './payload';

import {
  StandardAuthorization,
  SponsoredAuthorization,
  createSingleSigSpendingCondition,
  createMultiSigSpendingCondition,
} from './authorization';

import {
  publicKeyToString,
  createStacksPrivateKey,
  getPublicKey,
  publicKeyToAddress,
  pubKeyfromPrivKey,
  publicKeyFromBuffer,
} from './keys';

import { TransactionSigner } from './signer';

import {
  PostCondition,
  STXPostCondition,
  FungiblePostCondition,
  NonFungiblePostCondition,
  createSTXPostCondition,
  createFungiblePostCondition,
  createNonFungiblePostCondition,
} from './postcondition';

import {
  AddressHashMode,
  AddressVersion,
  FungibleConditionCode,
  NonFungibleConditionCode,
  PostConditionMode,
  PayloadType,
  AnchorMode,
  TransactionVersion,
  TxRejectedReason,
  SingleSigHashMode,
} from './constants';

import { AssetInfo, createLPList, createStandardPrincipal, createContractPrincipal } from './types';

import { cvToHex, parseReadOnlyResponse, omit, validateTxId } from './utils';

import { fetchPrivate } from '@stacks/common';

import { ClarityValue, PrincipalCV } from './clarity';
import { validateContractCall, ClarityAbi } from './contract-abi';
import { c32address } from 'c32check';

/**
 * Lookup the nonce for an address from a core node
 *
 * @param {string} address - the c32check address to look up
 * @param {StacksNetwork} network - the Stacks network to look up address on
 *
 * @return a promise that resolves to an integer
 */
export async function getNonce(address: string, network?: StacksNetwork): Promise<bigint> {
  const defaultNetwork = new StacksMainnet();
  const url = network
    ? network.getAccountApiUrl(address)
    : defaultNetwork.getAccountApiUrl(address);
  const response = await fetchPrivate(url);
  if (!response.ok) {
    let msg = '';
    try {
      msg = await response.text();
    } catch (error) {}
    throw new Error(
      `Error fetching nonce. Response ${response.status}: ${response.statusText}. Attempted to fetch ${url} and failed with the message: "${msg}"`
    );
  }
  const responseText = await response.text();
  const result = JSON.parse(responseText) as { nonce: string };
  return BigInt(result.nonce);
}

/**
 * Estimate the total transaction fee in microstacks for a token transfer
 *
 * @param {StacksTransaction} transaction - the token transfer transaction to estimate fees for
 * @param {StacksNetwork} network - the Stacks network to estimate transaction for
 *
 * @return a promise that resolves to number of microstacks per byte
 */
export async function estimateTransfer(
  transaction: StacksTransaction,
  network?: StacksNetwork
): Promise<bigint> {
  if (transaction.payload.payloadType !== PayloadType.TokenTransfer) {
    throw new Error(
      `Transaction fee estimation only possible with ${
        PayloadType[PayloadType.TokenTransfer]
      } transactions. Invoked with: ${PayloadType[transaction.payload.payloadType]}`
    );
  }

  const requestHeaders = {
    Accept: 'application/text',
  };

  const fetchOptions = {
    method: 'GET',
    headers: requestHeaders,
  };

  const defaultNetwork = new StacksMainnet();
  const url = network
    ? network.getTransferFeeEstimateApiUrl()
    : defaultNetwork.getTransferFeeEstimateApiUrl();
  const response = await fetchPrivate(url, fetchOptions);
  if (!response.ok) {
    let msg = '';
    try {
      msg = await response.text();
    } catch (error) {}
    throw new Error(
      `Error estimating transaction fee. Response ${response.status}: ${response.statusText}. Attempted to fetch ${url} and failed with the message: "${msg}"`
    );
  }
  const feeRateResult = await response.text();
  const txBytes = BigInt(transaction.serialize().byteLength);
  const feeRate = BigInt(feeRateResult);
  return feeRate * txBytes;
}

export type SerializationRejection = {
  error: string;
  reason: TxRejectedReason.Serialization;
  reason_data: {
    message: string;
  };
  txid: string;
};

export type DeserializationRejection = {
  error: string;
  reason: TxRejectedReason.Deserialization;
  reason_data: {
    message: string;
  };
  txid: string;
};

export type SignatureValidationRejection = {
  error: string;
  reason: TxRejectedReason.SignatureValidation;
  reason_data: {
    message: string;
  };
  txid: string;
};

export type BadNonceRejection = {
  error: string;
  reason: TxRejectedReason.BadNonce;
  reason_data: {
    expected: number;
    actual: number;
    is_origin: boolean;
    principal: boolean;
  };
  txid: string;
};

export type FeeTooLowRejection = {
  error: string;
  reason: TxRejectedReason.FeeTooLow;
  reason_data: {
    expected: number;
    actual: number;
  };
  txid: string;
};

export type NotEnoughFundsRejection = {
  error: string;
  reason: TxRejectedReason.NotEnoughFunds;
  reason_data: {
    expected: string;
    actual: string;
  };
  txid: string;
};

export type NoSuchContractRejection = {
  error: string;
  reason: TxRejectedReason.NoSuchContract;
  reason_data?: undefined;
  txid: string;
};

export type NoSuchPublicFunctionRejection = {
  error: string;
  reason: TxRejectedReason.NoSuchPublicFunction;
  reason_data?: undefined;
  txid: string;
};

export type BadFunctionArgumentRejection = {
  error: string;
  reason: TxRejectedReason.BadFunctionArgument;
  reason_data: {
    message: string;
  };
  txid: string;
};

export type ContractAlreadyExistsRejection = {
  error: string;
  reason: TxRejectedReason.ContractAlreadyExists;
  reason_data: {
    contract_identifier: string;
  };
  txid: string;
};

export type PoisonMicroblocksDoNotConflictRejection = {
  error: string;
  reason: TxRejectedReason.PoisonMicroblocksDoNotConflict;
  reason_data?: undefined;
  txid: string;
};

export type PoisonMicroblockHasUnknownPubKeyHashRejection = {
  error: string;
  reason: TxRejectedReason.PoisonMicroblockHasUnknownPubKeyHash;
  reason_data?: undefined;
  txid: string;
};

export type PoisonMicroblockIsInvalidRejection = {
  error: string;
  reason: TxRejectedReason.PoisonMicroblockIsInvalid;
  reason_data?: undefined;
  txid: string;
};

export type BadAddressVersionByteRejection = {
  error: string;
  reason: TxRejectedReason.BadAddressVersionByte;
  reason_data?: undefined;
  txid: string;
};

export type NoCoinbaseViaMempoolRejection = {
  error: string;
  reason: TxRejectedReason.NoCoinbaseViaMempool;
  reason_data?: undefined;
  txid: string;
};

export type ServerFailureNoSuchChainTipRejection = {
  error: string;
  reason: TxRejectedReason.ServerFailureNoSuchChainTip;
  reason_data?: undefined;
  txid: string;
};

export type ServerFailureDatabaseRejection = {
  error: string;
  reason: TxRejectedReason.ServerFailureDatabase;
  reason_data: {
    message: string;
  };
  txid: string;
};

export type ServerFailureOtherRejection = {
  error: string;
  reason: TxRejectedReason.ServerFailureOther;
  reason_data: {
    message: string;
  };
  txid: string;
};

export type TxBroadcastResultOk = {
  txid: string;
  error?: undefined;
  reason?: undefined;
  reason_data?: undefined;
};

export type TxBroadcastResultRejected =
  | SerializationRejection
  | DeserializationRejection
  | SignatureValidationRejection
  | BadNonceRejection
  | FeeTooLowRejection
  | NotEnoughFundsRejection
  | NoSuchContractRejection
  | NoSuchPublicFunctionRejection
  | BadFunctionArgumentRejection
  | ContractAlreadyExistsRejection
  | PoisonMicroblocksDoNotConflictRejection
  | PoisonMicroblockHasUnknownPubKeyHashRejection
  | PoisonMicroblockIsInvalidRejection
  | BadAddressVersionByteRejection
  | NoCoinbaseViaMempoolRejection
  | ServerFailureNoSuchChainTipRejection
  | ServerFailureDatabaseRejection
  | ServerFailureOtherRejection;

export type TxBroadcastResult = TxBroadcastResultOk | TxBroadcastResultRejected;

/**
 * Broadcast the signed transaction to a core node
 *
 * @param {StacksTransaction} transaction - the token transfer transaction to broadcast
 * @param {StacksNetwork} network - the Stacks network to broadcast transaction to
 *
 * @returns {Promise} that resolves to a response if the operation succeeds
 */
export async function broadcastTransaction(
  transaction: StacksTransaction,
  network: StacksNetwork,
  attachment?: Buffer
): Promise<TxBroadcastResult> {
  const rawTx = transaction.serialize();
  const url = network.getBroadcastApiUrl();

  return broadcastRawTransaction(rawTx, url, attachment);
}

/**
 * Broadcast the signed transaction to a core node
 *
 * @param {Buffer} rawTx - the raw serialized transaction buffer to broadcast
 * @param {string} url - the broadcast endpoint URL
 *
 * @returns {Promise} that resolves to a response if the operation succeeds
 */
export async function broadcastRawTransaction(
  rawTx: Buffer,
  url: string,
  attachment?: Buffer
): Promise<TxBroadcastResult> {
  const options = {
    method: 'POST',
    headers: { 'Content-Type': attachment ? 'application/json' : 'application/octet-stream' },
    body: attachment
      ? JSON.stringify({
          tx: rawTx.toString('hex'),
          attachment: attachment.toString('hex'),
        })
      : rawTx,
  };

  const response = await fetchPrivate(url, options);
  if (!response.ok) {
    try {
      return (await response.json()) as TxBroadcastResult;
    } catch (e) {
      throw Error(`Failed to broadcast transaction: ${(e as Error).message}`);
    }
  }

  const text = await response.text();
  // Replace extra quotes around txid string
  const txid = text.replace(/["]+/g, '');
  const isValidTxId = validateTxId(txid);
  if (isValidTxId) {
    return {
      txid: txid,
    } as TxBroadcastResult;
  } else {
    throw new Error(text);
  }
}

/**
 * Fetch a contract's ABI
 *
 * @param {string} address - the contracts address
 * @param {string} contractName - the contracts name
 * @param {StacksNetwork} network - the Stacks network to broadcast transaction to
 *
 * @returns {Promise} that resolves to a ClarityAbi if the operation succeeds
 */
export async function getAbi(
  address: string,
  contractName: string,
  network: StacksNetwork
): Promise<ClarityAbi> {
  const options = {
    method: 'GET',
  };

  const url = network.getAbiApiUrl(address, contractName);

  const response = await fetchPrivate(url, options);
  if (!response.ok) {
    let msg = '';
    try {
      msg = await response.text();
    } catch (error) {}
    throw new Error(
      `Error fetching contract ABI for contract "${contractName}" at address ${address}. Response ${response.status}: ${response.statusText}. Attempted to fetch ${url} and failed with the message: "${msg}"`
    );
  }

  return JSON.parse(await response.text()) as ClarityAbi;
}

export interface MultiSigOptions {
  numSignatures: number;
  publicKeys: string[];
  signerKeys?: string[];
}

/**
 * STX token transfer transaction options
 */
export interface TokenTransferOptions {
  /** the address of the recipient of the token transfer */
  recipient: string | PrincipalCV;
  /** the amount to be transfered in microstacks */
  amount: IntegerType;
  /** the transaction fee in microstacks */
  fee?: IntegerType;
  /** the transaction nonce, which must be increased monotonically with each new transaction */
  nonce?: IntegerType;
  /** the network that the transaction will ultimately be broadcast to */
  network?: StacksNetwork;
  /** the transaction anchorMode, which specifies whether it should be
   * included in an anchor block or a microblock */
  anchorMode: AnchorMode;
  /** an arbitrary string to include in the transaction, must be less than 34 bytes */
  memo?: string;
  /** the post condition mode, specifying whether or not post-conditions must fully cover all
   * transfered assets */
  postConditionMode?: PostConditionMode;
  /** a list of post conditions to add to the transaction */
  postConditions?: PostCondition[];
  /** set to true if another account is sponsoring the transaction (covering the transaction fee) */
  sponsored?: boolean;
}

export interface UnsignedTokenTransferOptions extends TokenTransferOptions {
  publicKey: string;
}

export interface SignedTokenTransferOptions extends TokenTransferOptions {
  senderKey: string;
}

export interface UnsignedMultiSigTokenTransferOptions extends TokenTransferOptions {
  numSignatures: number;
  publicKeys: string[];
}

export interface SignedMultiSigTokenTransferOptions extends TokenTransferOptions {
  numSignatures: number;
  publicKeys: string[];
  signerKeys: string[];
}

/**
 * Generates an unsigned Stacks token transfer transaction
 *
 * Returns a Stacks token transfer transaction.
 *
 * @param  {UnsignedTokenTransferOptions | UnsignedMultiSigTokenTransferOptions} txOptions - an options object for the token transfer
 *
 * @return {Promis<StacksTransaction>}
 */
export async function makeUnsignedSTXTokenTransfer(
  txOptions: UnsignedTokenTransferOptions | UnsignedMultiSigTokenTransferOptions
): Promise<StacksTransaction> {
  const defaultOptions = {
    fee: BigInt(0),
    nonce: BigInt(0),
    network: new StacksMainnet(),
    postConditionMode: PostConditionMode.Deny,
    memo: '',
    sponsored: false,
  };

  const options = Object.assign(defaultOptions, txOptions);

  const payload = createTokenTransferPayload(options.recipient, options.amount, options.memo);

  let authorization = null;
  let spendingCondition = null;

  if ('publicKey' in options) {
    // single-sig
    spendingCondition = createSingleSigSpendingCondition(
      AddressHashMode.SerializeP2PKH,
      options.publicKey,
      options.nonce,
      options.fee
    );
  } else {
    // multi-sig
    spendingCondition = createMultiSigSpendingCondition(
      AddressHashMode.SerializeP2SH,
      options.numSignatures,
      options.publicKeys,
      options.nonce,
      options.fee
    );
  }

  if (options.sponsored) {
    authorization = new SponsoredAuthorization(spendingCondition);
  } else {
    authorization = new StandardAuthorization(spendingCondition);
  }

  const postConditions: PostCondition[] = [];
  if (options.postConditions && options.postConditions.length > 0) {
    options.postConditions.forEach(postCondition => {
      postConditions.push(postCondition);
    });
  }

  const lpPostConditions = createLPList(postConditions);
  const transaction = new StacksTransaction(
    options.network.version,
    authorization,
    payload,
    lpPostConditions,
    options.postConditionMode,
    options.anchorMode,
    options.network.chainId
  );

  if (txOptions.fee === undefined || txOptions.fee === null) {
    const txFee = await estimateTransfer(transaction, options.network);
    transaction.setFee(txFee);
  }

  if (txOptions.nonce === undefined || txOptions.nonce === null) {
    const addressVersion =
      options.network.version === TransactionVersion.Mainnet
        ? AddressVersion.MainnetSingleSig
        : AddressVersion.TestnetSingleSig;
    const senderAddress = c32address(addressVersion, transaction.auth.spendingCondition!.signer);
    const txNonce = await getNonce(senderAddress, options.network);
    transaction.setNonce(txNonce);
  }

  return transaction;
}

/**
 * Generates a signed Stacks token transfer transaction
 *
 * Returns a signed Stacks token transfer transaction.
 *
 * @param  {SignedTokenTransferOptions | SignedMultiSigTokenTransferOptions} txOptions - an options object for the token transfer
 *
 * @return {StacksTransaction}
 */
export async function makeSTXTokenTransfer(
  txOptions: SignedTokenTransferOptions | SignedMultiSigTokenTransferOptions
): Promise<StacksTransaction> {
  if ('senderKey' in txOptions) {
    const publicKey = publicKeyToString(getPublicKey(createStacksPrivateKey(txOptions.senderKey)));
    const options = omit(txOptions, 'senderKey');
    const transaction = await makeUnsignedSTXTokenTransfer({ publicKey, ...options });

    const privKey = createStacksPrivateKey(txOptions.senderKey);
    const signer = new TransactionSigner(transaction);
    signer.signOrigin(privKey);

    return transaction;
  } else {
    const options = omit(txOptions, 'signerKeys');
    const transaction = await makeUnsignedSTXTokenTransfer(options);

    const signer = new TransactionSigner(transaction);
    let pubKeys = txOptions.publicKeys;
    for (const key of txOptions.signerKeys) {
      const pubKey = pubKeyfromPrivKey(key);
      pubKeys = pubKeys.filter(pk => pk !== pubKey.data.toString('hex'));
      signer.signOrigin(createStacksPrivateKey(key));
    }

    for (const key of pubKeys) {
      signer.appendOrigin(publicKeyFromBuffer(Buffer.from(key, 'hex')));
    }

    return transaction;
  }
}

/**
 * Contract deploy transaction options
 */
export interface ContractDeployOptions {
  contractName: string;
  /** the Clarity code to be deployed */
  codeBody: string;
  /** a hex string of the private key of the transaction sender */
  senderKey: string;
  /** transaction fee in microstacks */
  fee?: IntegerType;
  /** the transaction nonce, which must be increased monotonically with each new transaction */
  nonce?: IntegerType;
  /** the network that the transaction will ultimately be broadcast to */
  network?: StacksNetwork;
  /** the transaction anchorMode, which specifies whether it should be
   * included in an anchor block or a microblock */
  anchorMode: AnchorMode;
  /** the post condition mode, specifying whether or not post-conditions must fully cover all
   * transfered assets */
  postConditionMode?: PostConditionMode;
  /** a list of post conditions to add to the transaction */
  postConditions?: PostCondition[];
  /** set to true if another account is sponsoring the transaction (covering the transaction fee) */
  sponsored?: boolean;
}

/**
 * Estimate the total transaction fee in microstacks for a contract deploy
 *
 * @param {StacksTransaction} transaction - the token transfer transaction to estimate fees for
 * @param {StacksNetwork} network - the Stacks network to estimate transaction for
 *
 * @return a promise that resolves to number of microstacks per byte
 */
export async function estimateContractDeploy(
  transaction: StacksTransaction,
  network?: StacksNetwork
): Promise<bigint> {
  if (transaction.payload.payloadType !== PayloadType.SmartContract) {
    throw new Error(
      `Contract deploy fee estimation only possible with ${
        PayloadType[PayloadType.SmartContract]
      } transactions. Invoked with: ${PayloadType[transaction.payload.payloadType]}`
    );
  }

  const requestHeaders = {
    Accept: 'application/text',
  };

  const fetchOptions = {
    method: 'GET',
    headers: requestHeaders,
  };

  // Place holder estimate until contract deploy fee estimation is fully implemented on Stacks
  // blockchain core
  const defaultNetwork = new StacksMainnet();
  const url = network
    ? network.getTransferFeeEstimateApiUrl()
    : defaultNetwork.getTransferFeeEstimateApiUrl();

  const response = await fetchPrivate(url, fetchOptions);
  if (!response.ok) {
    let msg = '';
    try {
      msg = await response.text();
    } catch (error) {}
    throw new Error(
      `Error estimating contract deploy fee. Response ${response.status}: ${response.statusText}. Attempted to fetch ${url} and failed with the message: "${msg}"`
    );
  }
  const feeRateResult = await response.text();
  const txBytes = intToBigInt(transaction.serialize().byteLength, false);
  const feeRate = intToBigInt(feeRateResult, false);
  return feeRate * txBytes;
}

/**
 * Generates a Clarity smart contract deploy transaction
 *
 * @param  {ContractDeployOptions} txOptions - an options object for the contract deploy
 *
 * Returns a signed Stacks smart contract deploy transaction.
 *
 * @return {StacksTransaction}
 */
export async function makeContractDeploy(
  txOptions: ContractDeployOptions
): Promise<StacksTransaction> {
  const defaultOptions = {
    fee: BigInt(0),
    nonce: BigInt(0),
    network: new StacksMainnet(),
    postConditionMode: PostConditionMode.Deny,
    sponsored: false,
  };

  const options = Object.assign(defaultOptions, txOptions);

  const payload = createSmartContractPayload(options.contractName, options.codeBody);

  const addressHashMode = AddressHashMode.SerializeP2PKH;
  const privKey = createStacksPrivateKey(options.senderKey);
  const pubKey = getPublicKey(privKey);

  let authorization = null;

  const spendingCondition = createSingleSigSpendingCondition(
    addressHashMode,
    publicKeyToString(pubKey),
    options.nonce,
    options.fee
  );

  if (options.sponsored) {
    authorization = new SponsoredAuthorization(spendingCondition);
  } else {
    authorization = new StandardAuthorization(spendingCondition);
  }

  const postConditions: PostCondition[] = [];
  if (options.postConditions && options.postConditions.length > 0) {
    options.postConditions.forEach(postCondition => {
      postConditions.push(postCondition);
    });
  }

  const lpPostConditions = createLPList(postConditions);
  const transaction = new StacksTransaction(
    options.network.version,
    authorization,
    payload,
    lpPostConditions,
    options.postConditionMode,
    options.anchorMode,
    options.network.chainId
  );

  if (txOptions.fee === undefined || txOptions.fee === null) {
    const txFee = await estimateContractDeploy(transaction, options.network);
    transaction.setFee(txFee);
  }

  if (txOptions.nonce === undefined || txOptions.nonce === null) {
    const addressVersion =
      options.network.version === TransactionVersion.Mainnet
        ? AddressVersion.MainnetSingleSig
        : AddressVersion.TestnetSingleSig;
    const senderAddress = publicKeyToAddress(addressVersion, pubKey);
    const txNonce = await getNonce(senderAddress, options.network);
    transaction.setNonce(txNonce);
  }

  if (options.senderKey) {
    const signer = new TransactionSigner(transaction);
    signer.signOrigin(privKey);
  }

  return transaction;
}

/**
 * Contract function call transaction options
 */
export interface ContractCallOptions {
  /** the Stacks address of the contract */
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  /** transaction fee in microstacks */
  fee?: IntegerType;
  feeEstimateApiUrl?: string;
  /** the transaction nonce, which must be increased monotonically with each new transaction */
  nonce?: IntegerType;
  /** the Stacks blockchain network that will ultimately be used to broadcast this transaction */
  network?: StacksNetwork;
  /** the transaction anchorMode, which specifies whether it should be
   * included in an anchor block or a microblock */
  anchorMode: AnchorMode;
  /** the post condition mode, specifying whether or not post-conditions must fully cover all
   * transfered assets */
  postConditionMode?: PostConditionMode;
  /** a list of post conditions to add to the transaction */
  postConditions?: PostCondition[];
  /** set to true to validate that the supplied function args match those specified in
   * the published contract */
  validateWithAbi?: boolean | ClarityAbi;
  /** set to true if another account is sponsoring the transaction (covering the transaction fee) */
  sponsored?: boolean;
}

export interface UnsignedContractCallOptions extends ContractCallOptions {
  publicKey: string;
}

export interface SignedContractCallOptions extends ContractCallOptions {
  senderKey: string;
}

export interface UnsignedMultiSigContractCallOptions extends ContractCallOptions {
  numSignatures: number;
  publicKeys: string[];
}

export interface SignedMultiSigContractCallOptions extends ContractCallOptions {
  numSignatures: number;
  publicKeys: string[];
  signerKeys: string[];
}

/**
 * Estimate the total transaction fee in microstacks for a contract function call
 *
 * @param {StacksTransaction} transaction - the token transfer transaction to estimate fees for
 * @param {StacksNetwork} network - the Stacks network to estimate transaction for
 *
 * @return a promise that resolves to number of microstacks per byte
 */
export async function estimateContractFunctionCall(
  transaction: StacksTransaction,
  network?: StacksNetwork
): Promise<bigint> {
  if (transaction.payload.payloadType !== PayloadType.ContractCall) {
    throw new Error(
      `Contract call fee estimation only possible with ${
        PayloadType[PayloadType.ContractCall]
      } transactions. Invoked with: ${PayloadType[transaction.payload.payloadType]}`
    );
  }

  const requestHeaders = {
    Accept: 'application/text',
  };

  const fetchOptions = {
    method: 'GET',
    headers: requestHeaders,
  };

  // Place holder estimate until contract call fee estimation is fully implemented on Stacks
  // blockchain core
  const defaultNetwork = new StacksMainnet();
  const url = network
    ? network.getTransferFeeEstimateApiUrl()
    : defaultNetwork.getTransferFeeEstimateApiUrl();

  const response = await fetchPrivate(url, fetchOptions);
  if (!response.ok) {
    let msg = '';
    try {
      msg = await response.text();
    } catch (error) {}
    throw new Error(
      `Error estimating contract call fee. Response ${response.status}: ${response.statusText}. Attempted to fetch ${url} and failed with the message: "${msg}"`
    );
  }
  const feeRateResult = await response.text();
  const txBytes = intToBigInt(transaction.serialize().byteLength, false);
  const feeRate = intToBigInt(feeRateResult, false);
  return feeRate * txBytes;
}

/**
 * Generates an unsigned Clarity smart contract function call transaction
 *
 * @param {UnsignedContractCallOptions | UnsignedMultiSigContractCallOptions} txOptions - an options object for the contract call
 *
 * @returns {Promise<StacksTransaction>}
 */
export async function makeUnsignedContractCall(
  txOptions: UnsignedContractCallOptions | UnsignedMultiSigContractCallOptions
): Promise<StacksTransaction> {
  const defaultOptions = {
    fee: BigInt(0),
    nonce: BigInt(0),
    network: new StacksMainnet(),
    postConditionMode: PostConditionMode.Deny,
    sponsored: false,
  };

  const options = Object.assign(defaultOptions, txOptions);

  const payload = createContractCallPayload(
    options.contractAddress,
    options.contractName,
    options.functionName,
    options.functionArgs
  );

  if (options?.validateWithAbi) {
    let abi: ClarityAbi;
    if (typeof options.validateWithAbi === 'boolean') {
      if (options?.network) {
        abi = await getAbi(options.contractAddress, options.contractName, options.network);
      } else {
        throw new Error('Network option must be provided in order to validate with ABI');
      }
    } else {
      abi = options.validateWithAbi;
    }

    validateContractCall(payload, abi);
  }

  let spendingCondition = null;
  let authorization = null;

  if ('publicKey' in options) {
    // single-sig
    spendingCondition = createSingleSigSpendingCondition(
      AddressHashMode.SerializeP2PKH,
      options.publicKey,
      options.nonce,
      options.fee
    );
  } else {
    // multi-sig
    spendingCondition = createMultiSigSpendingCondition(
      AddressHashMode.SerializeP2SH,
      options.numSignatures,
      options.publicKeys,
      options.nonce,
      options.fee
    );
  }

  if (options.sponsored) {
    authorization = new SponsoredAuthorization(spendingCondition);
  } else {
    authorization = new StandardAuthorization(spendingCondition);
  }

  const postConditions: PostCondition[] = [];
  if (options.postConditions && options.postConditions.length > 0) {
    options.postConditions.forEach(postCondition => {
      postConditions.push(postCondition);
    });
  }

  const lpPostConditions = createLPList(postConditions);
  const transaction = new StacksTransaction(
    options.network.version,
    authorization,
    payload,
    lpPostConditions,
    options.postConditionMode,
    options.anchorMode,
    options.network.chainId
  );

  if (txOptions.fee === undefined || txOptions.fee === null) {
    const txFee = await estimateContractFunctionCall(transaction, options.network);
    transaction.setFee(txFee);
  }

  if (txOptions.nonce === undefined || txOptions.nonce === null) {
    const addressVersion =
      options.network.version === TransactionVersion.Mainnet
        ? AddressVersion.MainnetSingleSig
        : AddressVersion.TestnetSingleSig;
    const senderAddress = c32address(addressVersion, transaction.auth.spendingCondition!.signer);
    const txNonce = await getNonce(senderAddress, options.network);
    transaction.setNonce(txNonce);
  }

  return transaction;
}

/**
 * Generates a Clarity smart contract function call transaction
 *
 * @param  {SignedContractCallOptions | SignedMultiSigContractCallOptions} txOptions - an options object for the contract function call
 *
 * Returns a signed Stacks smart contract function call transaction.
 *
 * @return {StacksTransaction}
 */
export async function makeContractCall(
  txOptions: SignedContractCallOptions | SignedMultiSigContractCallOptions
): Promise<StacksTransaction> {
  if ('senderKey' in txOptions) {
    const publicKey = publicKeyToString(getPublicKey(createStacksPrivateKey(txOptions.senderKey)));
    const options = omit(txOptions, 'senderKey');
    const transaction = await makeUnsignedContractCall({ publicKey, ...options });

    const privKey = createStacksPrivateKey(txOptions.senderKey);
    const signer = new TransactionSigner(transaction);
    signer.signOrigin(privKey);

    return transaction;
  } else {
    const options = omit(txOptions, 'signerKeys');
    const transaction = await makeUnsignedContractCall(options);

    const signer = new TransactionSigner(transaction);
    let pubKeys = txOptions.publicKeys;
    for (const key of txOptions.signerKeys) {
      const pubKey = pubKeyfromPrivKey(key);
      pubKeys = pubKeys.filter(pk => pk !== pubKey.data.toString('hex'));
      signer.signOrigin(createStacksPrivateKey(key));
    }

    for (const key of pubKeys) {
      signer.appendOrigin(publicKeyFromBuffer(Buffer.from(key, 'hex')));
    }

    return transaction;
  }
}

/**
 * Generates a STX post condition with a standard principal
 *
 * Returns a STX post condition object
 *
 * @param address - the c32check address
 * @param conditionCode - the condition code
 * @param amount - the amount of STX tokens
 */
export function makeStandardSTXPostCondition(
  address: string,
  conditionCode: FungibleConditionCode,
  amount: IntegerType
): STXPostCondition {
  return createSTXPostCondition(createStandardPrincipal(address), conditionCode, amount);
}

/**
 * Generates a STX post condition with a contract principal
 *
 * Returns a STX post condition object
 *
 * @param address - the c32check address of the contract
 * @param contractName - the name of the contract
 * @param conditionCode - the condition code
 * @param amount - the amount of STX tokens
 *
 * @return {STXPostCondition}
 */
export function makeContractSTXPostCondition(
  address: string,
  contractName: string,
  conditionCode: FungibleConditionCode,
  amount: IntegerType
): STXPostCondition {
  return createSTXPostCondition(
    createContractPrincipal(address, contractName),
    conditionCode,
    amount
  );
}

/**
 * Generates a fungible token post condition with a standard principal
 *
 * Returns a fungible token post condition object
 *
 * @param address - the c32check address
 * @param conditionCode - the condition code
 * @param amount - the amount of fungible tokens
 * @param assetInfo - asset info describing the fungible token
 */
export function makeStandardFungiblePostCondition(
  address: string,
  conditionCode: FungibleConditionCode,
  amount: IntegerType,
  assetInfo: string | AssetInfo
): FungiblePostCondition {
  return createFungiblePostCondition(
    createStandardPrincipal(address),
    conditionCode,
    amount,
    assetInfo
  );
}

/**
 * Generates a fungible token post condition with a contract principal
 *
 * Returns a fungible token post condition object
 *
 * @param address - the c32check address
 * @param contractName - the name of the contract
 * @param conditionCode - the condition code
 * @param amount - the amount of fungible tokens
 * @param assetInfo - asset info describing the fungible token
 */
export function makeContractFungiblePostCondition(
  address: string,
  contractName: string,
  conditionCode: FungibleConditionCode,
  amount: IntegerType,
  assetInfo: string | AssetInfo
): FungiblePostCondition {
  return createFungiblePostCondition(
    createContractPrincipal(address, contractName),
    conditionCode,
    amount,
    assetInfo
  );
}

/**
 * Generates a non-fungible token post condition with a standard principal
 *
 * Returns a non-fungible token post condition object
 *
 * @param  {String} address - the c32check address
 * @param  {FungibleConditionCode} conditionCode - the condition code
 * @param  {AssetInfo} assetInfo - asset info describing the non-fungible token
 * @param  {ClarityValue} assetName - asset name describing the non-fungible token
 *
 * @return {NonFungiblePostCondition}
 */
export function makeStandardNonFungiblePostCondition(
  address: string,
  conditionCode: NonFungibleConditionCode,
  assetInfo: string | AssetInfo,
  assetName: ClarityValue
): NonFungiblePostCondition {
  return createNonFungiblePostCondition(
    createStandardPrincipal(address),
    conditionCode,
    assetInfo,
    assetName
  );
}

/**
 * Generates a non-fungible token post condition with a contract principal
 *
 * Returns a non-fungible token post condition object
 *
 * @param  {String} address - the c32check address
 * @param  {String} contractName - the name of the contract
 * @param  {FungibleConditionCode} conditionCode - the condition code
 * @param  {AssetInfo} assetInfo - asset info describing the non-fungible token
 * @param  {ClarityValue} assetName - asset name describing the non-fungible token
 *
 * @return {NonFungiblePostCondition}
 */
export function makeContractNonFungiblePostCondition(
  address: string,
  contractName: string,
  conditionCode: NonFungibleConditionCode,
  assetInfo: string | AssetInfo,
  assetName: ClarityValue
): NonFungiblePostCondition {
  return createNonFungiblePostCondition(
    createContractPrincipal(address, contractName),
    conditionCode,
    assetInfo,
    assetName
  );
}

/**
 * Read only function options
 *
 * @param  {String} contractAddress - the c32check address of the contract
 * @param  {String} contractName - the contract name
 * @param  {String} functionName - name of the function to be called
 * @param  {[ClarityValue]} functionArgs - an array of Clarity values as arguments to the function call
 * @param  {StacksNetwork} network - the Stacks blockchain network this transaction is destined for
 * @param  {String} senderAddress - the c32check address of the sender
 */

export interface ReadOnlyFunctionOptions {
  contractName: string;
  contractAddress: string;
  functionName: string;
  functionArgs: ClarityValue[];
  /** the network that the contract which contains the function is deployed to */
  network?: StacksNetwork;
  /** address of the sender */
  senderAddress: string;
}

/**
 * Calls a read only function from a contract interface
 *
 * @param  {ReadOnlyFunctionOptions} readOnlyFunctionOptions - the options object
 *
 * Returns an object with a status bool (okay) and a result string that is a serialized clarity value in hex format.
 *
 * @return {ClarityValue}
 */
export async function callReadOnlyFunction(
  readOnlyFunctionOptions: ReadOnlyFunctionOptions
): Promise<ClarityValue> {
  const defaultOptions = {
    network: new StacksMainnet(),
  };

  const options = Object.assign(defaultOptions, readOnlyFunctionOptions);

  const { contractName, contractAddress, functionName, functionArgs, network, senderAddress } =
    options;

  const url = network.getReadOnlyFunctionCallApiUrl(contractAddress, contractName, functionName);

  const args = functionArgs.map(arg => cvToHex(arg));

  const body = JSON.stringify({
    sender: senderAddress,
    arguments: args,
  });

  const response = await fetchPrivate(url, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    let msg = '';
    try {
      msg = await response.text();
    } catch (error) {}
    throw new Error(
      `Error calling read-only function. Response ${response.status}: ${response.statusText}. Attempted to fetch ${url} and failed with the message: "${msg}"`
    );
  }

  return response.json().then(responseJson => parseReadOnlyResponse(responseJson));
}

/**
 * Sponsored transaction options
 */
export interface SponsorOptionsOpts {
  /** the origin-signed transaction */
  transaction: StacksTransaction;
  /** the sponsor's private key */
  sponsorPrivateKey: string;
  /** the transaction fee amount to sponsor */
  fee?: IntegerType;
  /** the nonce of the sponsor account */
  sponsorNonce?: IntegerType;
  /** the hashmode of the sponsor's address */
  sponsorAddressHashmode?: AddressHashMode;
  /** the Stacks blockchain network that this transaction will ultimately be broadcast to */
  network?: StacksNetwork;
}

/**
 * Constructs and signs a sponsored transaction as the sponsor
 *
 * @param  {SponsorOptionsOpts} sponsorOptions - the sponsor options object
 *
 * Returns a signed sponsored transaction.
 *
 * @return {ClarityValue}
 */
export async function sponsorTransaction(
  sponsorOptions: SponsorOptionsOpts
): Promise<StacksTransaction> {
  const defaultOptions = {
    fee: 0 as IntegerType,
    sponsorNonce: 0 as IntegerType,
    sponsorAddressHashmode: AddressHashMode.SerializeP2PKH as SingleSigHashMode,
  };

  const options = Object.assign(defaultOptions, sponsorOptions);
  const network =
    sponsorOptions.network ??
    (options.transaction.version === TransactionVersion.Mainnet
      ? new StacksMainnet()
      : new StacksTestnet());
  const sponsorPubKey = pubKeyfromPrivKey(options.sponsorPrivateKey);

  if (sponsorOptions.fee === undefined || sponsorOptions.fee === null) {
    let txFee = BigInt(0);
    switch (options.transaction.payload.payloadType) {
      case PayloadType.TokenTransfer:
        txFee = await estimateTransfer(options.transaction, network);
        break;
      case PayloadType.SmartContract:
        txFee = await estimateContractDeploy(options.transaction, network);
        break;
      case PayloadType.ContractCall:
        txFee = await estimateContractFunctionCall(options.transaction, network);
        break;
      default:
        throw new Error(
          `Sponsored transactions not supported for transaction type ${
            PayloadType[options.transaction.payload.payloadType]
          }`
        );
    }
    options.transaction.setFee(txFee);
    options.fee = txFee;
  }

  if (sponsorOptions.sponsorNonce === undefined || sponsorOptions.sponsorNonce === null) {
    const addressVersion =
      network.version === TransactionVersion.Mainnet
        ? AddressVersion.MainnetSingleSig
        : AddressVersion.TestnetSingleSig;

    const senderAddress = publicKeyToAddress(addressVersion, sponsorPubKey);
    const sponsorNonce = await getNonce(senderAddress, network);
    options.sponsorNonce = sponsorNonce;
  }

  const sponsorSpendingCondition = createSingleSigSpendingCondition(
    options.sponsorAddressHashmode,
    publicKeyToString(sponsorPubKey),
    options.sponsorNonce,
    options.fee
  );

  options.transaction.setSponsor(sponsorSpendingCondition);

  const privKey = createStacksPrivateKey(options.sponsorPrivateKey);
  const signer = TransactionSigner.createSponsorSigner(
    options.transaction,
    sponsorSpendingCondition
  );
  signer.signSponsor(privKey);

  return options.transaction;
}
