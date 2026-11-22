// A test selector, NOT user consent or a macOS permission grant. Real protocol
// tests normal-start the helper and read TCC state; obtain scoped consent first.
export const NATIVE_PROTOCOL_OPT_IN = 'COMPUTER_USE_NATIVE_PROTOCOL_TESTS';

export function nativeProtocolTestSkip({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'darwin') return 'Real native tests require macOS.';
  if (!Object.hasOwn(env, NATIVE_PROTOCOL_OPT_IN) || env[NATIVE_PROTOCOL_OPT_IN] !== '1') {
    return `Real native tests require separate consent and explicit ${NATIVE_PROTOCOL_OPT_IN}=1; normal startup reads TCC state.`;
  }
  return false;
}

export function assertNativeProtocolTestOptIn(options) {
  const reason = nativeProtocolTestSkip(options);
  if (reason !== false) {
    const error = new Error(reason);
    error.code = 'native_test_opt_in_required';
    throw error;
  }
}
