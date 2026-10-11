import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
@Injectable() export class DatabaseService implements OnModuleDestroy { private readonly pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}):undefined; async status(){if(!this.pool)return {connected:false,mode:'local-memory'};await this.pool.query('select 1');return {connected:true,mode:'postgres'}} async onModuleDestroy(){await this.pool?.end()} }
