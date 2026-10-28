import assert from 'node:assert/strict';
import {pbkdf2Sync} from 'node:crypto';
import {test} from 'node:test';
import {checkPassword,hashPassword} from '../src/lib/auth';

const password='Preview-รหัสผ่าน-2026!';
const salt='00112233445566778899aabbccddeeff';
const nativeHash=pbkdf2Sync(password,Buffer.from(salt,'hex'),600000,32,'sha256').toString('hex');
const provisioned=`pbkdf2:600000:${salt}:${nativeHash}`;

test('existing 600,000-round hashes verify even when native WebCrypto refuses PBKDF2',async t=>{
  const native=t.mock.method(crypto.subtle,'deriveBits',async()=>{
    throw new DOMException('Pbkdf2 failed: iteration counts above 100000 are not supported','NotSupportedError');
  });
  assert.equal(await checkPassword(password,provisioned),true);
  assert.equal(await checkPassword(password+'wrong',provisioned),false);
  assert.equal(native.mock.callCount(),0);
});

test('new salted hashes match an independent native PBKDF2 implementation',async()=>{
  const first=await hashPassword(password);const second=await hashPassword(password);
  assert.notEqual(first,second);
  for(const encoded of [first,second]){
    assert.match(encoded,/^pbkdf2:600000:[0-9a-f]{32}:[0-9a-f]{64}$/);
    const [,iterations,actualSalt,hash]=encoded.split(':');
    assert.equal(hash,pbkdf2Sync(password,Buffer.from(actualSalt,'hex'),Number(iterations),32,'sha256').toString('hex'));
  }
});

test('unsupported costs and malformed stored hashes fail closed',async()=>{
  for(const invalid of ['',provisioned+':extra',provisioned.replace(':600000:',':100000:'),provisioned.replace(salt,'invalid'),provisioned.slice(0,-1)]){
    assert.equal(await checkPassword(password,invalid),false);
  }
});
