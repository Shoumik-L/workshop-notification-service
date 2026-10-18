// How long to wait before retry number `attempts`: 2s, 4s, 8s, ... capped, plus a little randomness
// so many failed messages do not all retry at the exact same moment.
function retryDelaySeconds(attempts, baseSeconds = 2, capSeconds = 60) {
  const exponential = Math.min(baseSeconds * 2 ** (attempts - 1), capSeconds);
  return exponential * (0.75 + Math.random() * 0.5);
}

module.exports = { retryDelaySeconds };
