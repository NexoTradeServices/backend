// THE CAPABILITY TOKEN SERVICE -- Feature 1005, capability tokens.
//
// The whole platform's login-exempt links ride this one module: mint (the
// notification dispatcher only, at send time -- ADR 0004), validate, consume
// and the revocation hooks later features call from reassign/cancel/supersede
// (4006, 6003). The four capability pages themselves (4003, 4005, 6009, 6003)
// are not this feature's job -- see the plan's Scope.
export {
  assertLinkSpec,
  consumeCapabilityToken,
  mintCapabilityLink,
  revokeByAssignment,
  revokeByJob,
  tightenExpiryByJob,
  validateCapabilityToken,
} from "./service.js";
export {
  CAPABILITY_LINK_CONTEXT_KEY,
  CapabilityTokenType,
  type CapabilityTokenDb,
  type CapabilityTokenResult,
  type LinkSpec,
  type MintedLink,
} from "./types.js";
