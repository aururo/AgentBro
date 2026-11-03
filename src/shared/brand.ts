/**
 * Product brand constants.
 *
 * `src/shared` must stay free of Electron and Node imports so that the main,
 * preload and renderer bundles can all read these values. Anything that ends up
 * in an identifier, a path or a file name stays ASCII — see
 * `docs/brand-agentbro-plan.md` for the naming rules that must not change
 * (`appId`, `userData`, plugin ids).
 */
export const BRAND_NAME = 'AgentBro'

/** Name used by development builds so both can be installed side by side. */
export const BRAND_NAME_DEV = 'AgentBro Dev'

/**
 * Brand name used in UI copy. Kept separate from `BRAND_NAME` so a future
 * channel variant ("AgentBro · Insiders") does not have to touch paths.
 */
export const BRAND_DISPLAY = 'AgentBro'

export const BRAND_VERSION_NOTE_EN = 'Harness is updated with AgentBro.'
export const BRAND_VERSION_NOTE_ZH = 'Harness 随 AgentBro 更新。'
