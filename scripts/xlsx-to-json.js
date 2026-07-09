// scripts/xlsx-to-json.js
// يحوّل ملف Excel (UUID | Distributor | Notes) لـ data/uuid-map.json
//
// الاستخدام:
//   npm i xlsx        (مرة واحدة)
//   node scripts/xlsx-to-json.js "مسار/الملف.xlsx"
//
// لو مبعتّش مسار، هيدوّر على أول .xlsx جنبه.

const fs = require('fs');
const path = require('path');

let XLSX;
try {
  XLSX = require('xlsx');
} catch (_) {
  console.error('محتاج تسطّب المكتبة الأول:  npm i xlsx');
  process.exit(1);
}

const inFile = process.argv[2];
if (!inFile || !fs.existsSync(inFile)) {
  console.error('مش لاقي الملف. مرّر مسار الـ xlsx:  node scripts/xlsx-to-json.js file.xlsx');
  process.exit(1);
}

const wb = XLSX.readFile(inFile);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

const out = {};
let added = 0;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r || !r[0]) continue;
  const uuid = String(r[0]).trim().toLowerCase().replace(/-/g, '');
  const dist = r[1] ? String(r[1]).trim() : '';
  if (!dist) continue;
  const notes = r[2] ? String(r[2]).trim() : '';
  const subs = notes ? notes.split(',').map((s) => s.trim()).filter(Boolean) : [];
  out[uuid] = { distributor: dist, sub_labels: subs };
  added++;
}

const dest = path.join(__dirname, '..', 'data', 'uuid-map.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
console.log(`تم: ${added} موزّع → ${dest}`);
console.log('لو السيرفر شغّال، نادِ:  curl -X POST http://localhost:3005/api/reload');
