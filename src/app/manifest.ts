import type {MetadataRoute} from 'next';
export default function manifest():MetadataRoute.Manifest{return {name:'RRS Connect',short_name:'RRS Connect',description:'กล่องข้อความและงานทีมขาย',start_url:'/',scope:'/',display:'standalone',background_color:'#f5f7fa',theme_color:'#0f766e',icons:[{src:'/rrs-app.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]};}
