// The product's name as a human sees it; identifiers keep theirs.
export const BRAND = 'TycStation';
export const PRODUCT = 'Lightshow';
export const WORDMARK = `${BRAND} ${PRODUCT}`;
export const KICKER = 'engine · lighting controller';

export const pageTitle = (view) => (view ? `${view} · ${WORDMARK}` : WORDMARK);
