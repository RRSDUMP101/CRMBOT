export function openLocalDatabase(): never { throw new Error('Local database unavailable in Workers'); }
export function seedDemoDatabase(): never { throw new Error('Demo seeding unavailable in Workers'); }
export function localBucket():never {throw new Error('Local file storage is unavailable in Workers');}
