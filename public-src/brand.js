// The product's name as a human sees it; identifiers (storage keys, routes,
// package names) keep theirs.
export const BRAND = 'TycStation';
export const PRODUCT = 'Lightshow';
export const WORDMARK = `${BRAND} ${PRODUCT}`;
export const KICKER = 'engine · lighting controller';

/** The browser title: the view first, the wordmark last. */
export const pageTitle = (view) => (view ? `${view} · ${WORDMARK}` : WORDMARK);
