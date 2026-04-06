/**
 * Standardized API response helpers.
 */

export function paginated(res, items, options = {}) {
  const { cursor, hasMore = false, total } = options;
  res.json({ items, cursor: cursor || null, hasMore, ...(total != null ? { total } : {}) });
}

export function success(res, data, status = 200) {
  res.status(status).json(data);
}

export function created(res, data) {
  res.status(201).json(data);
}
