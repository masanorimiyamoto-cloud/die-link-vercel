// tools/hash-pin.mjs
// 最初の管理者のPIN暗号値を作る（管理画面に入る前の一度だけ使う）。
//   node tools/hash-pin.mjs 1234
// 出力された pbkdf2-sha256$... を Airtable の TableStaff「PIN暗号値」に貼る。
// 2人目以降は管理画面（/staff-admin.html）から設定できる。
import { hashPin } from '../api/_auth.js';

const pin = process.argv[2];
if (!pin) {
  console.error('使い方: node tools/hash-pin.mjs <4〜8桁のPIN>');
  process.exit(1);
}
console.log(await hashPin(pin));
