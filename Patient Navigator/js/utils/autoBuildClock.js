// Use the same IST instant for the noon cutoff and its local calendar day.
// UTC getters on this shifted date keep the device timezone out of both.
export function getIstAutoBuildWindow(now) {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return {
    istDay: ist.toISOString().slice(0, 10),
    afterNoon: ist.getUTCHours() >= 12,
  };
}
