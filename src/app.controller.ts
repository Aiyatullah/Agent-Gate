import { Body, Controller, Delete, Get, Headers, NotFoundException, Param, Patch, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { AppService, Role, Tool } from './app.service.js';
import { DatabaseService } from './database.service.js';
import { AuthService } from './auth.service.js';
import { RedisService } from './redis.service.js';
import { ExecutionService } from './execution.service.js';
import { MetricsService } from './metrics.service.js';

type CreateTool = Omit<Tool, 'id'>;
type PatchTool = Partial<Pick<Tool, 'status' | 'approvalMode' | 'risk' | 'name' | 'description'>>;
type TokenBody = { role?: Role; scopes?: string[]; tenantId?: string; sub?: string; actorName?: string; client?: string };

@ApiTags('Agent Gate')
@Controller()
export class AppController {
  constructor(
    private readonly service: AppService,
    private readonly jwt: JwtService,
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly redis: RedisService,
    private readonly exec: ExecutionService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('health')
  async health() {
    return { ...this.service.health(), database: await this.database.status(), redis: await this.redis.status(), executionQueue: this.exec.mode, demoAuth: this.auth.demoEnabled };
  }

  @ApiExcludeEndpoint() @Get('metrics')
  async metricsText(@Res() res: Response, @Headers('authorization') h?: string) {
    const token = process.env.METRICS_TOKEN;
    if (token && h !== `Bearer ${token}`) throw new UnauthorizedException();
    res.type('text/plain').send(this.metrics.render());
  }

  @Post('auth/demo-token')
  token(@Body() b: TokenBody) {
    if (!this.auth.demoEnabled) throw new NotFoundException();
    const role = b.role ?? 'admin';
    return {
      accessToken: this.jwt.sign({
        sub: b.sub ?? (role === 'agent' ? 'agent-research-01' : 'user-admin-01'),
        tenantId: b.tenantId ?? '00000000-0000-0000-0000-000000000001',
        role,
        scopes: b.scopes ?? ['tools:read', 'tools:email:send'],
        actorName: b.actorName ?? (role === 'agent' ? 'Research Agent' : 'Aiyatullah Admin'),
        client: b.client ?? (role === 'agent' ? 'Claude Code' : 'Dashboard'),
      }),
    };
  }

  @ApiBearerAuth() @Get('tools')
  tools(@Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.listTools(a));
  }

  @ApiBearerAuth() @Post('tools')
  create(@Body() body: CreateTool, @Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.createTool(a, body));
  }

  @ApiBearerAuth() @Patch('tools/:id')
  update(@Param('id') id: string, @Body() body: PatchTool, @Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.updateTool(a, id, body));
  }

  @ApiBearerAuth() @Delete('tools/:id')
  remove(@Param('id') id: string, @Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.deleteTool(a, id));
  }

  @ApiBearerAuth() @Get('users')
  users(@Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.listUsers(a));
  }

  @ApiBearerAuth() @Patch('users/:id/role')
  setRole(@Param('id') id: string, @Body() body: { role: Role }, @Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.setUserRole(a, id, body.role));
  }

  @ApiBearerAuth() @Post('tools/:id/calls')
  call(@Param('id') id: string, @Body() body: Record<string, unknown>, @Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.invoke(a, id, body));
  }

  @ApiBearerAuth() @Get('audit-logs')
  audit(@Query('limit') limit?: string, @Query('offset') offset?: string, @Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.listAudit(a, Number(limit), Number(offset)));
  }

  @ApiBearerAuth() @Post('audit-logs/:id/replay')
  replay(@Param('id') id: string, @Body() body: { providers?: string[]; prompt?: string } = {}, @Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.replay(a, id, body ?? {}));
  }

  @ApiBearerAuth() @Get('approvals')
  approvals(@Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.listApprovals(a));
  }

  @ApiBearerAuth() @Post('approvals/:id/:decision')
  decide(@Param('id') id: string, @Param('decision') d: string, @Headers('authorization') h?: string) {
    return this.actor(h).then(a => this.service.decide(a, id, d === 'approve'));
  }

  private actor(h?: string) {
    return this.auth.actor(h);
  }
}
