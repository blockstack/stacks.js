import { validateStacksAddress, validateTxId } from '../src/utils';

const TX_ID_WITH_NO_0x = '117a6522b4e9ec27ff10bbe3940a4a07fd58e5352010b4143992edb05a7130c7';
const TX_ID = '0x117a6522b4e9ec27ff10bbe3940a4a07fd58e5352010b4143992edb05a7130c7';
const INVALID_EXAMPLE =
  'Failed to deserialize posted transaction: Invalid Stacks string: non-printable or non-ASCII string';

const INVALID_EXAMPLE_WITH_TXID = `Failed to deserialize posted transaction: Invalid Stacks string: non-printable or non-ASCII string. ${TX_ID}`;

describe(validateStacksAddress.name, () => {
  test('it returns true for a legit address', () => {
    const validAddresses = [
      'STVTVW5E80EET19EZ3J8W3NZKR6RHNFG58TKQGXH',
      'STMFBYXTWAZD0NYMHSRQBZX1190EMZ42VD326PNP',
      'ST22ENKAF6J5G43TZFQS1WTV0YEH8VNX2SX048RA5',
    ];
    validAddresses.forEach(address => expect(validateStacksAddress(address)).toBeTruthy());
  });

  test('it returns false for nonsense input', () => {
    const nonsenseNotRealSillyAddresses = [
      'update borrow transfer trumpet stem topic resemble youth trophy later slam air subway invite salt quantum fossil smoke hero lift sense boat green wave',
      '03680327df912362e7d2280fea0fb80af2ba70f8fdc853d36f3c621fb93a73b801',
      'one upon a time in a land far far away',
      'lkjsdfksfjd(*&(*7sedf;lkj',
      'In the beginning...',
      // missing one char
      'ST3S6T6BS4DJ7AW74KVMNYXWH5SZ1WXX8JBCYZVY',
    ];
    nonsenseNotRealSillyAddresses.forEach(nonAddress =>
      expect(validateStacksAddress(nonAddress)).toBeFalsy()
    );
  });
});

describe(validateTxId.name, () => {
  test('correctly validates a txid without 0x', () => {
    expect(validateTxId(TX_ID_WITH_NO_0x)).toEqual(true);
  });
  test('correctly validates a txid with 0x', () => {
    expect(validateTxId(TX_ID)).toEqual(true);
  });
  test('errors when it is too short', () => {
    expect(validateTxId(TX_ID.split('30c7')[0])).toEqual(false);
  });
  test('errors when it is too long', () => {
    expect(validateTxId(TX_ID + TX_ID)).toEqual(false);
  });
  test('errors when a message is passed', () => {
    expect(validateTxId(INVALID_EXAMPLE)).toEqual(false);
  });
  test('errors when a message is passed even though there is a valid txid included', () => {
    expect(validateTxId(INVALID_EXAMPLE_WITH_TXID)).toEqual(false);
  });
});
