import { toESTDate } from '../../src/utils';

/** Minutes since midnight in America/New_York for an ISO bar timestamp. */
export function barMinutes(timestamp: string): number {
  const est = toESTDate(new Date(timestamp));
  return est.getHours() * 60 + est.getMinutes();
}
