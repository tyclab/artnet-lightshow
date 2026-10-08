
# Bump major when a consumer would break (field removed, unit changed, event meaning changed); minor for additive changes.
SCHEMA_VERSION = '2.2'

# Older documents are re-analysed. src/analysis-cache.ts reads this line by regex: keep it as MIN_COMPATIBLE = 'X.Y'.
MIN_COMPATIBLE = '2.0'
