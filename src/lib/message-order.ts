/** Source timestamps remain authoritative; customer sequence resolves timestamp ties. */
export function messageOrder(alias:''|'m'='',descending=false){
 const column=alias?alias+'.':'',direction=descending?'DESC':'ASC';
 const sequence=`CASE WHEN ${column}customer_seq BETWEEN 1 AND 9007199254740991 THEN ${column}customer_seq ELSE 9007199254740991 END`;
 return `${column}created_at ${direction},${sequence} ${direction},${column}id ${direction}`;
}
