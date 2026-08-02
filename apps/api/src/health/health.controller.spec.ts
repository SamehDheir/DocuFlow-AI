import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const buildController = async (queryRaw: jest.Mock): Promise<HealthController> => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: { $queryRaw: queryRaw } }],
    }).compile();

    return moduleRef.get(HealthController);
  };

  it('reports ok when the database responds', async () => {
    const controller = await buildController(jest.fn().mockResolvedValue([{ '?column?': 1 }]));

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('up');
    expect(typeof result.uptime).toBe('number');
  });

  it('reports degraded rather than throwing when the database is unreachable', async () => {
    // The probe must still answer during an outage — an exception here would
    // surface as a 500 and make Docker restart an otherwise healthy container.
    const controller = await buildController(
      jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );

    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe('down');
  });
});
