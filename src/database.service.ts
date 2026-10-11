import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
export type StoredTool={id:string;name:string;slug:string;kind:'rest'|'mcp';scopes:string[];risk:'low'|'high';description:string;status:'draft'|'active'|'disabled';approvalMode:'auto'|'required'|'deny';endpoint?:string};
@Injectable() export class DatabaseService implements OnModuleDestroy {
 private readonly pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}):undefined;
 get enabled(){return Boolean(this.pool)}
 async status(){if(!this.pool)return {connected:false,mode:'local-memory'};await this.pool.query('select 1');return {connected:true,mode:'postgres'}}
 async listTools(tenantId:string):Promise<StoredTool[]>{if(!this.pool)return [];const r=await this.pool.query(`select id::text,name,slug,kind,scopes,risk,descriptor->>'description' description,status,approval_mode "approvalMode",endpoint from public.tools where tenant_id=$1 order by created_at desc`,[tenantId]);return r.rows}
 async createTool(tenantId:string,tool:Omit<StoredTool,'id'>):Promise<StoredTool>{if(!this.pool)throw new Error('Database is not configured.');const r=await this.pool.query(`insert into public.tools (tenant_id,name,slug,kind,scopes,risk,descriptor,status,approval_mode,endpoint) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id::text,name,slug,kind,scopes,risk,descriptor->>'description' description,status,approval_mode "approvalMode",endpoint`,[tenantId,tool.name,tool.slug,tool.kind,tool.scopes,tool.risk,JSON.stringify({description:tool.description}),tool.status,tool.approvalMode,tool.endpoint??null]);return r.rows[0]}
 async onModuleDestroy(){await this.pool?.end()}
}
