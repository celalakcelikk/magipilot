'use strict';

/**
 * Splits an array into chunks of `size` elements. The last chunk may be shorter.
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(items, size) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError('size must be a positive integer');
  }
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    <FILL>chunks.push(items.slice(i, i + size));</FILL>
  }
  return chunks;
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function unique(items) {
  return [...new Set(items)];
}

module.exports = { chunk, unique };
