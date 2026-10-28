import {defineCloudflareConfig} from '@opennextjs/cloudflare';
// All CRM routes are dynamic; no shared incremental cache can contain customer data.
export default defineCloudflareConfig();
