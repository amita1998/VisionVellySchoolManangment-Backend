import crypto from 'node:crypto';

/**
 * Temporary passwords must satisfy the same policy the API enforces
 * (upper + lower + digit, 8+) and must not be guessable.
 */
export function temporaryPassword(length = 14) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '@#$%&*';
  const pick = (alphabet) => alphabet[crypto.randomInt(alphabet.length)];

  const characters = [pick(upper), pick(lower), pick(digits), pick(special)];
  const everything = upper + lower + digits + special;
  while (characters.length < Math.max(8, length)) characters.push(pick(everything));
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapWith = crypto.randomInt(index + 1);
    [characters[index], characters[swapWith]] = [characters[swapWith], characters[index]];
  }
  return characters.join('');
}

export default temporaryPassword;
