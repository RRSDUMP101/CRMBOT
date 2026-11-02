import type {MetadataRoute} from 'next';
export default function manifest():MetadataRoute.Manifest{return {name:'RRS CRM',short_name:'RRS CRM',description:'กล่องข้อความและงานทีมขาย',start_url:'/',scope:'/',display:'standalone',background_color:'#f1f5fb',theme_color:'#08243f',icons:[{src:'/rrs-app.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]};}
