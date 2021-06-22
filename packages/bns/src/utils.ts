import { Buffer } from '@stacks/common';
import { bufferCV, uintCV, hash160 } from '@stacks/transactions';

import BN from 'bn.js';

export function decodeFQN(fqdn: string): {
  name: string;
  namespace: string;
  subdomain?: string;
} {
  const nameParts = fqdn.split('.');
  if (nameParts.length > 2) {
    const subdomain = nameParts[0];
    const name = nameParts[1];
    const namespace = nameParts[2];
    return {
      subdomain,
      name,
      namespace,
    };
  } else {
    const name = nameParts[0];
    const namespace = nameParts[1];
    return {
      name,
      namespace,
    };
  }
}

export const bufferCVFromString = (string: string) => bufferCV(Buffer.from(string));

export const uintCVFromBN = (int: BN) => uintCV(int.toString(10));

export const getZonefileHash = (zonefile: string) => hash160(Buffer.from(zonefile));
