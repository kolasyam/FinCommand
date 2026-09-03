import 'dotenv/config';
import { syncFromZoho } from './lib/services/zoho';

const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
const fyId = 'ddf3e124-1049-4d2c-b856-9a70f6a9f9a7';

(async () => {
  try {
    const result = await syncFromZoho(companyId, fyId, null);
    console.log('Sync result:', result);
  } catch (e) {
    console.error('Sync FAILED:', (e as Error).message);
    process.exitCode = 1;
  }
})();
