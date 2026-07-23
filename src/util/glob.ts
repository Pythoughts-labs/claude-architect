function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

/**
 * The single path matcher behind the write allowlist, forbidden scope, and every
 * other scope decision. It lived in three separate copies, two of which enforce
 * the write boundary — a matcher that can drift between the freeze check and the
 * structural verifier is a hole waiting to open.
 *
 * `*` stops at a path separator; `**` crosses them, and `**​/` also matches zero
 * segments so `src/**​/x` matches `src/x`.
 */
export function globMatches(
  pattern: string,
  candidate: string,
  caseInsensitive = false,
): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) break;
    if (character !== "*") {
      expression += escapeRegex(character);
      continue;
    }
    if (pattern[index + 1] !== "*") {
      expression += "[^/]*";
      continue;
    }
    index += 1;
    if (pattern[index + 1] === "/") {
      expression += "(?:.*/)?";
      index += 1;
    } else {
      expression += ".*";
    }
  }
  return new RegExp(`${expression}$`, caseInsensitive ? "i" : undefined).test(candidate);
}
