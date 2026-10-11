import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { AppService, Role, Tool } from './app.service.js';
import { DatabaseService } from './database.service.js';

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
  ) {}

  @Get('health')
  async health() {
    return { ...this.service.health(), database: await this.database.status() };
  }

  @Post('auth/demo-token')
  token(@Body() b: TokenBody) {
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
    return this.service.listTools(this.actor(h));
  }

  @ApiBearerAuth() @Post('tools')
  create(@Body() body: CreateTool, @Headers('authorization') h?: string) {
    return this.service.createTool(this.actor(h), body);
  }

  @ApiBearerAuth() @Patch('tools/:id')
  update(@Param('id') id: string, @Body() body: PatchTool, @Headers('authorization') h?: string) {
    return this.service.updateTool(this.actor(h), id, body);
  }

  @ApiBearerAuth() @Delete('tools/:id')
  remove(@Param('id') id: string, @Headers('authorization') h?: string) {
    return this.service.deleteTool(this.actor(h), id);
  }

  @ApiBearerAuth() @Get('users')
  users(@Headers('authorization') h?: string) {
    return this.service.listUsers(this.actor(h));
  }

  @ApiBearerAuth() @Post('tools/:id/calls')
  call(@Param('id') id: string, @Body() body: Record<string, unknown>, @Headers('authorization') h?: string) {
    return this.service.invoke(this.actor(h), id, body);
  }

  @ApiBearerAuth() @Get('audit-logs')
  audit(@Query('limit') limit?: string, @Query('offset') offset?: string, @Headers('authorization') h?: string) {
    return this.service.listAudit(this.actor(h), Number(limit), Number(offset));
  }

  @ApiBearerAuth() @Post('audit-logs/:id/replay')
  replay(@Param('id') id: string, @Headers('authorization') h?: string) {
    return this.service.replay(this.actor(h), id);
  }

  @ApiBearerAuth() @Get('approvals')
  approvals(@Headers('authorization') h?: string) {
    return this.service.listApprovals(this.actor(h));
  }

  @ApiBearerAuth() @Post('approvals/:id/:decision')
  decide(@Param('id') id: string, @Param('decision') d: string, @Headers('authorization') h?: string) {
    return this.service.decide(this.actor(h), id, d === 'approve');
  }

  private actor(h?: string) {
    try {
      if (!h?.startsWith('Bearer ')) throw Error();
      return this.jwt.verify(h.slice(7));
    } catch {
      throw new UnauthorizedException('A valid bearer token is required.');
    }
  }
}
