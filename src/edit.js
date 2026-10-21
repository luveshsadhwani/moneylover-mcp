// Payload fields observed in Money Lover's public web app (2026-10-21):
// /static/js/app.5b4b1d6ce89b2d6a7178.js, AddTransactionDialog and Transactions.
export const referenceId = value => typeof value === 'string' ? value : value?._id;
export const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const validAmount = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value) && Number(value) > 0;
export const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
export function categoryMatches(category, id) {
  return referenceId(category) === id || (Array.isArray(category?.categories) && category.categories.includes(id));
}
export function snapshotMatches(transaction, expected) {
  return categoryMatches(transaction.category, expected.categoryId) &&
    Number(transaction.amount) === Number(expected.amount) &&
    transaction.displayDate?.slice(0, 10) === expected.date && (transaction.note ?? '') === expected.note;
}
export function editPayload(transaction, walletId, desired, reject) {
  // Linked transfers, debt/loan and recurring entries have additional semantics.
  if (transaction.parent || transaction.related || transaction.transfer || transaction.isTransfer || transaction.recurring || transaction.repeat ||
      /^IS_(DEBT|LOAN|REPAYMENT|TRANSFER)/.test(transaction.category?.metadata ?? '')) reject('linked_transaction_unsupported');
  if (!Array.isArray(transaction.with) || !Array.isArray(transaction.images) || transaction.images.length > 1 ||
      !transaction.with.every(v => typeof v === 'string') || !transaction.images.every(v => typeof v === 'string')) reject('unsupported_transaction_metadata');
  let address = {};
  try { address = typeof transaction.address === 'string' ? JSON.parse(transaction.address || '{}') : transaction.address ?? {}; }
  catch { reject('unsupported_transaction_address'); }
  if (!address || typeof address !== 'object' || Array.isArray(address)) reject('unsupported_transaction_address');
  const campaigns = transaction.campaign ?? [];
  if (!Array.isArray(campaigns) || campaigns.some(c => c.type !== 6) || campaigns.length > 1) reject('unsupported_transaction_campaign');
  const event = referenceId(transaction.event ?? campaigns[0]) ?? '';
  if (transaction.event != null && !referenceId(transaction.event)) reject('unsupported_transaction_metadata');
  if (typeof event !== 'string') reject('unsupported_transaction_metadata');
  return {
    _id: transaction._id, with: transaction.with, account: walletId,
    category: desired.categoryId, amount: Number(desired.amount), note: desired.note,
    displayDate: desired.date, event, exclude_report: transaction.exclude_report ?? false,
    longtitude: transaction.longtitude ?? 0, latitude: transaction.latitude ?? 0,
    addressName: address.name ?? '', addressDetails: address.details ?? '', addressIcon: address.icon ?? '',
    ...(transaction.remind === undefined ? {} : { remind: transaction.remind }), image: transaction.images[0] ?? ''
  };
}
