// Small formatting helpers shared by the server and the report files.

const formatNumber = n => Number(n).toLocaleString('en-IE');
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

module.exports = { formatNumber, clip };