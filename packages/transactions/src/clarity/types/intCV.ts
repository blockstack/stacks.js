import { Buffer } from '@stacks/common';
import BigNum from 'bn.js';
import { CLARITY_INT_BYTE_SIZE, CLARITY_INT_SIZE } from '../../constants';
import { ClarityType } from '../clarityValue';

const MAX_U128 = new BigNum(2).pow(new BigNum(128)).sub(new BigNum(1));
const MAX_I128 = new BigNum(2).pow(new BigNum(127)).sub(new BigNum(1));
const MIN_I128 = new BigNum(-2).pow(new BigNum(127));

interface IntCV {
  readonly type: ClarityType.Int;
  readonly value: BigNum;
}

function valueToBN(value: unknown, signed: boolean): BigNum {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError(`Invalid value. Values of type 'number' must be an integer.`);
    }
    return new BigNum(value);
  }
  if (typeof value === 'string') {
    if (value.toLowerCase().startsWith('0x')) {
      // Convert to buffer then fall through to the buffer condition
      value = Buffer.from(value.slice(2), 'hex');
    } else {
      return new BigNum(value);
    }
  }
  if (typeof value === 'bigint') {
    return new BigNum(value.toString());
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    let bn: BigNum;
    if (signed) {
      if (value.byteLength < CLARITY_INT_BYTE_SIZE) {
        const paddedBytes = new Uint8Array(CLARITY_INT_BYTE_SIZE);
        // Extend sign-bit while padding to full byte length.
        if (value[0] >>> 7) {
          paddedBytes.fill(0xff);
        }
        paddedBytes.set(value, CLARITY_INT_BYTE_SIZE - value.byteLength);
        bn = new BigNum(paddedBytes, 'be').fromTwos(CLARITY_INT_SIZE);
      } else {
        bn = new BigNum(value, 'be').fromTwos(CLARITY_INT_SIZE);
      }
    } else {
      bn = new BigNum(value, 'be');
    }
    return bn;
  }
  if (value instanceof BigNum || BigNum.isBN(value)) {
    return value;
  }
  throw new TypeError(
    `Invalid value type. Must be a number, bigint, integer-string, hex-string, BN.js instance, or Buffer.`
  );
}

const intCV = (value: number | string | bigint | Uint8Array | BigNum): IntCV => {
  const bn = valueToBN(value, true);

  if (bn.gt(MAX_I128)) {
    throw new RangeError(
      `Cannot construct clarity integer from value greater than ${MAX_I128.toString()}`
    );
  } else if (bn.lt(MIN_I128)) {
    throw new RangeError(
      `Cannot construct clarity integer form value less than ${MIN_I128.toString()}`
    );
  } else if (bn.bitLength() > CLARITY_INT_SIZE) {
    throw new RangeError(
      `Cannot construct clarity integer from value greater than ${CLARITY_INT_SIZE} bits`
    );
  }

  return { type: ClarityType.Int, value: bn };
};

interface UIntCV {
  readonly type: ClarityType.UInt;
  readonly value: BigNum;
}

const uintCV = (value: number | string | bigint | Uint8Array | BigNum): UIntCV => {
  const bn = valueToBN(value, false);

  if (bn.isNeg()) {
    throw new RangeError('Cannot construct unsigned clarity integer from negative value');
  } else if (bn.gt(MAX_U128)) {
    throw new RangeError(
      `Cannot construct unsigned clarity integer greater than ${MAX_U128.toString()}`
    );
  } else if (bn.bitLength() > CLARITY_INT_SIZE) {
    throw new RangeError(
      `Cannot construct unsigned clarity integer from value greater than ${CLARITY_INT_SIZE} bits`
    );
  }

  return { type: ClarityType.UInt, value: bn };
};

export { IntCV, UIntCV, intCV, uintCV };
