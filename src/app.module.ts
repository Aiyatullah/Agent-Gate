import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from './database.service.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({ secret: process.env.JWT_SECRET ?? 'local-development-secret-change-me', signOptions: { expiresIn: '1h' } })],
  controllers: [AppController],
  providers: [AppService, DatabaseService],
})
export class AppModule {}
