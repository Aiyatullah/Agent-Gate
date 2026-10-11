import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from './database.service.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConnectorService } from './connector.service.js';
import { ExecutionService } from './execution.service.js';
import { AuthService } from './auth.service.js';
import { RedisService } from './redis.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { MetricsService } from './metrics.service.js';
import { ProviderService } from './provider.service.js';
import { McpHttpController } from './mcp-http.controller.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({ secret: process.env.JWT_SECRET ?? 'local-development-secret-change-me', signOptions: { expiresIn: '1h' } })],
  controllers: [AppController, McpHttpController],
  providers: [AppService, DatabaseService, ConnectorService, ExecutionService, AuthService, RedisService, RateLimitService, MetricsService, ProviderService],
})
export class AppModule {}
