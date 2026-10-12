const https = require('https');
const zlib = require('zlib');

const query = encodeURIComponent('"INFANT research centre"[Affiliation]');
const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${query}&retmax=5&retmode=json&sort=date`;

https.get(url, (res) => {
  let stream = res;
  if (res.headers['content-encoding'] === 'gzip') {
    stream = res.pipe(zlib.createGunzip());
  }
  let data = '';
  stream.on('data', chunk => data += chunk);
  stream.on('end', () => {
    const parsed = JSON.parse(data);
    console.log('Count:', parsed.esearchresult?.count);
    console.log('IDs:', parsed.esearchresult?.idlist);
  });
}).on('error', e => console.error(e.message));