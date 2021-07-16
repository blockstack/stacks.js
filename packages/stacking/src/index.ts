import { Buffer, IntegerType, intToBigInt } from '@stacks/common';
import {
  makeContractCall,
  bufferCV,
  uintCV,
  tupleCV,
  ClarityType,
  broadcastTransaction,
  standardPrincipalCV,
  ContractCallOptions,
  TxBroadcastResult,
  UIntCV,
  BufferCV,
  ContractCallPayload,
  StacksTransaction,
  callReadOnlyFunction,
  cvToString,
  ClarityValue,
  ResponseErrorCV,
  TupleCV,
  noneCV,
  someCV,
  validateStacksAddress,
  AnchorMode,
} from '@stacks/transactions';
import {
  BurnchainRewardListResponse,
  BurnchainRewardsTotal,
  BurnchainRewardSlotHolderListResponse,
} from '@stacks/stacks-blockchain-api-types';
import { StacksNetwork } from '@stacks/network';
import BN from 'bn.js';
import { StackingErrors } from './constants';
import { fetchPrivate } from '@stacks/common';
import { decodeBtcAddress } from './utils';
export * from './utils';

export interface PoxInfo {
  contract_id: string;
  first_burnchain_block_height: number;
  min_amount_ustx: string;
  registration_window_length: 250;
  rejection_fraction: number;
  reward_cycle_id: number;
  reward_cycle_length: number;
  rejection_votes_left_required: number;
}

export type StackerInfo =
  | {
      stacked: false;
    }
  | {
      stacked: true;
      details: {
        amount_microstx: string;
        first_reward_cycle: number;
        lock_period: number;
        unlock_height: number;
        pox_address: {
          version: Buffer;
          hashbytes: Buffer;
        };
      };
    };

export interface BlockTimeInfo {
  mainnet: {
    target_block_time: number;
  };
  testnet: {
    target_block_time: number;
  };
}

export interface CoreInfo {
  burn_block_height: number;
  stable_pox_consensus: string;
}

export interface BalanceInfo {
  balance: string;
  nonce: number;
}

export interface RewardsError {
  error: string;
}

export interface RewardOptions {
  limit: number;
  offset: number;
}

export interface StackingEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * Lock stx check options
 */
export interface CanLockStxOptions {
  /** the reward Bitcoin address */
  poxAddress: string;
  /** number of cycles to lock */
  cycles: number;
}

/**
 * Lock stx options
 */
export interface LockStxOptions {
  /** private key to sign transaction */
  privateKey: string;
  /** number of cycles to lock */
  cycles: number;
  /** the reward Bitcoin address */
  poxAddress: string;
  /** number of microstacks to lock */
  amountMicroStx: IntegerType;
  /** the burnchain block height to begin lock */
  burnBlockHeight: number;
}

/**
 * Delegate stx options
 */
export interface DelegateStxOptions {
  /** number of microstacks to delegate */
  amountMicroStx: IntegerType;
  /** the STX address of the delegatee */
  delegateTo: string;
  /** the burnchain block height after which delegation is revoked */
  untilBurnBlockHeight?: number;
  /** the reward Bitcoin address of the delegator */
  poxAddress?: string;
  /** private key to sign transaction */
  privateKey: string;
}

/**
 * Delegate stack stx options
 */
export interface DelegateStackStxOptions {
  /** the STX address of the delegator */
  stacker: string;
  /** number of microstacks to lock */
  amountMicroStx: IntegerType;
  /** the reward Bitcoin address of the delegator */
  poxAddress: string;
  /** the burnchain block height to begin lock */
  burnBlockHeight: number;
  /** number of cycles to lock */
  cycles: number;
  /** private key to sign transaction */
  privateKey: string;
  /** nonce for the transaction */
  nonce?: IntegerType;
}

export interface StackAggregationCommitOptions {
  poxAddress: string;
  rewardCycle: number;
  privateKey: string;
}

export class StackingClient {
  constructor(public address: string, public network: StacksNetwork) {}

  /**
   * Get stacks node info
   *
   * @returns {Promise<CoreInfo>} that resolves to a CoreInfo response if the operation succeeds
   */
  async getCoreInfo(): Promise<CoreInfo> {
    const url = this.network.getInfoUrl();
    return fetchPrivate(url).then(res => res.json());
  }

  /**
   * Get stacks node pox info
   *
   * @returns {Promise<PoxInfo>} that resolves to a PoxInfo response if the operation succeeds
   */
  async getPoxInfo(): Promise<PoxInfo> {
    const url = this.network.getPoxInfoUrl();
    return fetchPrivate(url).then(res => res.json());
  }

  /**
   * Get stacks node target block time
   *
   * @returns {Promise<number>} that resolves to a number if the operation succeeds
   */
  async getTargetBlockTime(): Promise<number> {
    const url = this.network.getBlockTimeInfoUrl();
    const res = await fetchPrivate(url).then(res => res.json());

    if (this.network.isMainnet()) {
      return res.mainnet.target_block_time;
    } else {
      return res.testnet.target_block_time;
    }
  }

  async getAccountStatus(): Promise<any> {
    const url = this.network.getAccountApiUrl(this.address);
    return fetchPrivate(url).then(res => res.json());
  }

  /**
   * Get account balance
   *
   * @returns promise resolves to a bigint if the operation succeeds
   */
  async getAccountBalance(): Promise<bigint> {
    return this.getAccountStatus().then(res => {
      return BigInt(res.balance);
    });
  }

  /**
   * Get reward cycle duration in seconds
   *
   * @returns {Promise<number>} that resolves to a number if the operation succeeds
   */
  async getCycleDuration(): Promise<number> {
    const poxInfoPromise = this.getPoxInfo();
    const targetBlockTimePromise = await this.getTargetBlockTime();

    return Promise.all([poxInfoPromise, targetBlockTimePromise]).then(
      ([poxInfo, targetBlockTime]) => {
        return poxInfo.reward_cycle_length * targetBlockTime;
      }
    );
  }

  /**
   * Get the total burnchain rewards total for the set address
   *
   * @returns {Promise<TotalRewardsResponse | RewardsError>} that resolves to TotalRewardsResponse or RewardsError
   */
  async getRewardsTotalForBtcAddress(): Promise<BurnchainRewardsTotal | RewardsError> {
    const url = this.network.getRewardsTotalUrl(this.address);
    return fetchPrivate(url).then(res => res.json());
  }

  /**
   * Get burnchain rewards for the set address
   *
   * @returns {Promise<RewardsResponse | RewardsError>} that resolves to RewardsResponse or RewardsError
   */
  async getRewardsForBtcAddress(
    options?: RewardOptions
  ): Promise<BurnchainRewardListResponse | RewardsError> {
    const url = `${this.network.getRewardsUrl(this.address, options)}`;
    return fetchPrivate(url).then(res => res.json());
  }

  /**
   * Get burnchain rewards holders for the set address
   *
   * @returns {Promise<RewardHoldersResponse | RewardsError>} that resolves to RewardHoldersResponse or RewardsError
   */
  async getRewardHoldersForBtcAddress(
    options?: RewardOptions
  ): Promise<BurnchainRewardSlotHolderListResponse | RewardsError> {
    const url = `${this.network.getRewardHoldersUrl(this.address, options)}`;
    return fetchPrivate(url).then(res => res.json());
  }

  /**
   * Get number of seconds until next reward cycle
   *
   * @returns {Promise<number>} that resolves to a number if the operation succeeds
   */
  async getSecondsUntilNextCycle(): Promise<number> {
    const poxInfoPromise = this.getPoxInfo();
    const targetBlockTimePromise = await this.getTargetBlockTime();
    const coreInfoPromise = this.getCoreInfo();

    return Promise.all([poxInfoPromise, targetBlockTimePromise, coreInfoPromise]).then(
      ([poxInfo, targetBlockTime, coreInfo]) => {
        const blocksToNextCycle =
          poxInfo.reward_cycle_length -
          ((coreInfo.burn_block_height - poxInfo.first_burnchain_block_height) %
            poxInfo.reward_cycle_length);
        return blocksToNextCycle * targetBlockTime;
      }
    );
  }

  /**
   * Check if stacking is enabled for next reward cycle
   *
   * @returns {Promise<boolean>} that resolves to a bool if the operation succeeds
   */
  async isStackingEnabledNextCycle(): Promise<boolean> {
    return (await this.getPoxInfo()).rejection_votes_left_required > 0;
  }

  /**
   * Check if account has minimum require amount of Stacks for stacking
   *
   * @returns {Promise<boolean>} that resolves to a bool if the operation succeeds
   */
  async hasMinimumStx(): Promise<boolean> {
    const balance = await this.getAccountBalance();
    const min = BigInt((await this.getPoxInfo()).min_amount_ustx);
    return balance >= min;
  }

  /**
   * Check if account can lock stx
   *
   * @param {CanLockStxOptions} options - a required lock STX options object
   *
   * @returns {Promise<StackingEligibility>} that resolves to a StackingEligibility object if the operation succeeds
   */
  async canStack({ poxAddress, cycles }: CanLockStxOptions): Promise<StackingEligibility> {
    const balancePromise: Promise<bigint> = this.getAccountBalance();
    const poxInfoPromise = this.getPoxInfo();

    return Promise.all([balancePromise, poxInfoPromise])
      .then(([balance, poxInfo]) => {
        const { hashMode, data } = decodeBtcAddress(poxAddress);
        const hashModeBuffer = bufferCV(new BN(hashMode, 10).toArrayLike(Buffer));
        const hashbytes = bufferCV(data);
        const poxAddressCV = tupleCV({
          hashbytes,
          version: hashModeBuffer,
        });

        const [contractAddress, contractName] = this.parseContractId(poxInfo.contract_id);

        return callReadOnlyFunction({
          network: this.network,
          contractName,
          contractAddress,
          functionName: 'can-stack-stx',
          senderAddress: this.address,
          functionArgs: [
            poxAddressCV,
            uintCV(balance.toString()),
            uintCV(poxInfo.reward_cycle_id),
            uintCV(cycles.toString()),
          ],
        });
      })
      .then((responseCV: ClarityValue) => {
        if (responseCV.type === ClarityType.ResponseOk) {
          return {
            eligible: true,
          };
        } else {
          const errorCV = responseCV as ResponseErrorCV;
          return {
            eligible: false,
            reason: StackingErrors[+cvToString(errorCV.value)],
          };
        }
      });
  }

  /**
   * Generate and broadcast a stacking transaction to lock STX
   *
   * @param {LockStxOptions} options - a required lock STX options object
   *
   * @returns {Promise<string>} that resolves to a broadcasted txid if the operation succeeds
   */
  async stack({
    amountMicroStx,
    poxAddress,
    cycles,
    privateKey,
    burnBlockHeight,
  }: LockStxOptions): Promise<TxBroadcastResult> {
    const poxInfo = await this.getPoxInfo();
    const contract = poxInfo.contract_id;

    const txOptions = this.getStackOptions({
      amountMicroStx,
      cycles,
      poxAddress,
      contract,
      burnBlockHeight,
    });
    const tx = await makeContractCall({
      ...txOptions,
      senderKey: privateKey,
    });

    return broadcastTransaction(tx);
  }

  /**
   * As a delegatee, generate and broadcast a transaction to create a delegation relationship
   *
   * @param {DelegateStxOptions} options - a required delegate STX options object
   *
   * @returns {Promise<string>} that resolves to a broadcasted txid if the operation succeeds
   */
  async delegateStx({
    amountMicroStx,
    delegateTo,
    untilBurnBlockHeight,
    poxAddress,
    privateKey,
  }: DelegateStxOptions): Promise<TxBroadcastResult> {
    const poxInfo = await this.getPoxInfo();
    const contract = poxInfo.contract_id;

    const txOptions = this.getDelegateOptions({
      contract,
      amountMicroStx,
      delegateTo,
      untilBurnBlockHeight,
      poxAddress,
    });

    const tx = await makeContractCall({
      ...txOptions,
      senderKey: privateKey,
    });

    return broadcastTransaction(tx);
  }

  /**
   * As a delegator, generate and broadcast transactions to stack for multiple delegatees. This will lock up tokens owned by the delegatees.
   *
   * @param {DelegateStackStxOptions} options - a required delegate stack STX options object
   *
   * @returns {Promise<string>} that resolves to a broadcasted txid if the operation succeeds
   */
  async delegateStackStx({
    stacker,
    amountMicroStx,
    poxAddress,
    burnBlockHeight,
    cycles,
    privateKey,
    nonce,
  }: DelegateStackStxOptions): Promise<TxBroadcastResult> {
    const poxInfo = await this.getPoxInfo();
    const contract = poxInfo.contract_id;

    const txOptions = this.getDelegateStackOptions({
      contract,
      stacker,
      amountMicroStx,
      poxAddress,
      burnBlockHeight,
      cycles,
      nonce,
    });
    const tx = await makeContractCall({
      ...txOptions,
      senderKey: privateKey,
    });

    return broadcastTransaction(tx);
  }

  /**
   * As a delegator, generate and broadcast a transaction to commit partially committed delegatee tokens
   *
   * @param {StackAggregationCommitOptions} options - a required stack aggregation commit options object
   *
   * @returns {Promise<string>} that resolves to a broadcasted txid if the operation succeeds
   */
  async stackAggregationCommit({
    poxAddress,
    rewardCycle,
    privateKey,
  }: StackAggregationCommitOptions): Promise<TxBroadcastResult> {
    const poxInfo = await this.getPoxInfo();
    const contract = poxInfo.contract_id;

    const txOptions = this.getStackAggregationCommitOptions({
      contract,
      poxAddress,
      rewardCycle,
    });
    const tx = await makeContractCall({
      ...txOptions,
      senderKey: privateKey,
    });

    return broadcastTransaction(tx);
  }

  /**
   * As a delegatee, generate and broadcast a transaction to terminate the delegation relationship
   *
   * @param {string} privateKey - the private key to be used for the revoke call
   *
   * @returns {Promise<string>} that resolves to a broadcasted txid if the operation succeeds
   */
  async revokeDelegateStx(privateKey: string): Promise<TxBroadcastResult> {
    const poxInfo = await this.getPoxInfo();
    const contract = poxInfo.contract_id;

    const txOptions = this.getRevokeDelegateStxOptions(contract);

    const tx = await makeContractCall({
      ...txOptions,
      senderKey: privateKey,
    });

    return broadcastTransaction(tx);
  }

  getStackOptions({
    amountMicroStx,
    poxAddress,
    cycles,
    contract,
    burnBlockHeight,
  }: {
    cycles: number;
    poxAddress: string;
    amountMicroStx: IntegerType;
    contract: string;
    burnBlockHeight: number;
  }) {
    const { hashMode, data } = decodeBtcAddress(poxAddress);
    const hashModeBuffer = bufferCV(new BN(hashMode, 10).toArrayLike(Buffer));
    const hashbytes = bufferCV(data);
    const address = tupleCV({
      hashbytes,
      version: hashModeBuffer,
    });
    const [contractAddress, contractName] = this.parseContractId(contract);
    const network = this.network;
    const txOptions: ContractCallOptions = {
      contractAddress,
      contractName,
      functionName: 'stack-stx',
      // sum of uStx, address, burn_block_height, num_cycles
      functionArgs: [uintCV(amountMicroStx), address, uintCV(burnBlockHeight), uintCV(cycles)],
      validateWithAbi: true,
      network,
      anchorMode: AnchorMode.Any,
    };
    return txOptions;
  }

  getDelegateOptions({
    contract,
    amountMicroStx,
    delegateTo,
    untilBurnBlockHeight,
    poxAddress,
  }: {
    contract: string;
    amountMicroStx: IntegerType;
    delegateTo: string;
    untilBurnBlockHeight?: number;
    poxAddress?: string;
  }) {
    let address = undefined;

    if (poxAddress) {
      const { hashMode, data } = decodeBtcAddress(poxAddress);
      const hashModeBuffer = bufferCV(new BN(hashMode, 10).toArrayLike(Buffer));
      const hashbytes = bufferCV(data);
      address = someCV(
        tupleCV({
          hashbytes,
          version: hashModeBuffer,
        })
      );
    }

    const [contractAddress, contractName] = this.parseContractId(contract);
    const network = this.network;
    const txOptions: ContractCallOptions = {
      contractAddress,
      contractName,
      functionName: 'delegate-stx',
      functionArgs: [
        uintCV(amountMicroStx),
        standardPrincipalCV(delegateTo),
        untilBurnBlockHeight ? someCV(uintCV(untilBurnBlockHeight)) : noneCV(),
        address ? address : noneCV(),
      ],
      validateWithAbi: true,
      network,
      anchorMode: AnchorMode.Any,
    };
    return txOptions;
  }

  getDelegateStackOptions({
    contract,
    stacker,
    amountMicroStx,
    poxAddress,
    burnBlockHeight,
    cycles,
    nonce,
  }: {
    contract: string;
    stacker: string;
    amountMicroStx: IntegerType;
    poxAddress: string;
    burnBlockHeight: number;
    cycles: number;
    nonce?: IntegerType;
  }) {
    const { hashMode, data } = decodeBtcAddress(poxAddress);
    const hashModeBuffer = bufferCV(new BN(hashMode, 10).toArrayLike(Buffer));
    const hashbytes = bufferCV(data);
    const address = tupleCV({
      hashbytes,
      version: hashModeBuffer,
    });

    const [contractAddress, contractName] = this.parseContractId(contract);
    const network = this.network;
    const txOptions: ContractCallOptions = {
      contractAddress,
      contractName,
      functionName: 'delegate-stack-stx',
      functionArgs: [
        standardPrincipalCV(stacker),
        uintCV(amountMicroStx),
        address,
        uintCV(burnBlockHeight),
        uintCV(cycles),
      ],
      validateWithAbi: true,
      network,
      anchorMode: AnchorMode.Any,
    };

    if (nonce) {
      txOptions.nonce = nonce;
    }

    return txOptions;
  }

  getStackAggregationCommitOptions({
    contract,
    poxAddress,
    rewardCycle,
  }: {
    contract: string;
    poxAddress: string;
    rewardCycle: number;
  }) {
    const { hashMode, data } = decodeBtcAddress(poxAddress);
    const hashModeBuffer = bufferCV(new BN(hashMode, 10).toArrayLike(Buffer));
    const hashbytes = bufferCV(data);
    const address = tupleCV({
      hashbytes,
      version: hashModeBuffer,
    });

    const [contractAddress, contractName] = this.parseContractId(contract);
    const network = this.network;
    const txOptions: ContractCallOptions = {
      contractAddress,
      contractName,
      functionName: 'stack-aggregation-commit',
      functionArgs: [address, uintCV(rewardCycle)],
      validateWithAbi: true,
      network,
      anchorMode: AnchorMode.Any,
    };
    return txOptions;
  }

  getRevokeDelegateStxOptions(contract: string) {
    const [contractAddress, contractName] = this.parseContractId(contract);
    const network = this.network;
    const txOptions: ContractCallOptions = {
      contractAddress,
      contractName,
      functionName: 'revoke-delegate-stx',
      functionArgs: [],
      validateWithAbi: true,
      network,
      anchorMode: AnchorMode.Any,
    };
    return txOptions;
  }

  /**
   * Check stacking status
   *
   * @returns {Promise<StackerInfo>} that resolves to a StackerInfo object if the operation succeeds
   */
  async getStatus(): Promise<StackerInfo> {
    const poxInfo = await this.getPoxInfo();
    const [contractAddress, contractName] = this.parseContractId(poxInfo.contract_id);
    const account = await this.getAccountStatus();
    const functionName = 'get-stacker-info';

    return callReadOnlyFunction({
      contractAddress,
      contractName,
      functionName,
      senderAddress: this.address,
      functionArgs: [standardPrincipalCV(this.address)],
      network: this.network,
    }).then((responseCV: ClarityValue) => {
      if (responseCV.type === ClarityType.OptionalSome) {
        const someCV = responseCV;
        const tupleCV: TupleCV = someCV.value as TupleCV;
        const poxAddress: TupleCV = tupleCV.data['pox-addr'] as TupleCV;
        const amountMicroStx: UIntCV = tupleCV.data['amount-ustx'] as UIntCV;
        const firstRewardCycle: UIntCV = tupleCV.data['first-reward-cycle'] as UIntCV;
        const lockPeriod: UIntCV = tupleCV.data['lock-period'] as UIntCV;
        const version: BufferCV = poxAddress.data['version'] as BufferCV;
        const hashbytes: BufferCV = poxAddress.data['hashbytes'] as BufferCV;

        return {
          stacked: true,
          details: {
            amount_microstx: amountMicroStx.value.toString(),
            first_reward_cycle: Number(firstRewardCycle.value),
            lock_period: Number(lockPeriod.value),
            unlock_height: account.unlock_height,
            pox_address: {
              version: version.buffer,
              hashbytes: hashbytes.buffer,
            },
          },
        };
      } else if (responseCV.type === ClarityType.OptionalNone) {
        return {
          stacked: false,
        };
      } else {
        throw new Error(`Error fetching stacker info`);
      }
    });
  }

  /**
   * Adjust microstacks amount for locking after taking into account transaction fees
   *
   * @returns {StacksTransaction} that resolves to a transaction object if the operation succeeds
   */
  modifyLockTxFee({ tx, amountMicroStx }: { tx: StacksTransaction; amountMicroStx: IntegerType }) {
    const fee = tx.auth.getFee();
    (tx.payload as ContractCallPayload).functionArgs[0] = uintCV(
      intToBigInt(amountMicroStx, false) - fee
    );
    return tx;
  }

  /**
   * Parses a contract identifier and ensures it is formatted correctly
   *
   * @returns {Array<string>} a contract address and name
   */
  parseContractId(contract: string): string[] {
    const parts = contract.split('.');

    if (parts.length !== 2 || !validateStacksAddress(parts[0]) || parts[1] !== 'pox') {
      throw new Error('Stacking contract ID is malformed');
    }

    return parts;
  }
}
