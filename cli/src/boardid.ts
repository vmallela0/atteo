/** The board a join/create reply is about: the LAST board id on its first line, so a title that itself contains "(b_…)"
 *  can't redirect it, and it reads both 'Joined "<title>" (<id>)' and the id-only 'Joined <id>'. */
export function boardIdIn(line: string): string | undefined {
  const ids = line.match(/\bb_[a-z0-9]{8,32}\b/g);
  return ids?.[ids.length - 1];
}

