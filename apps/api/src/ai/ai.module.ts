import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { AI_PROVIDER, type AiProvider } from './ai-provider.interface';
import { GroqProvider } from './groq.provider';
import { NullAiProvider } from './null.provider';
import { XaiProvider } from './xai.provider';

/**
 * Picks the AI provider once, at boot.
 *
 * Resolved here rather than per call so the choice is made in one place and
 * logged once — a system quietly running on stub output is exactly the sort of
 * thing that should be obvious in the startup log rather than inferred later
 * from suspicious summaries.
 *
 * A missing key is a supported configuration, not an error: the pipeline still
 * runs end to end on NullAiProvider, so the queue, the status transitions, the
 * notifications and the search indexing are all exercised without a credential.
 */
@Module({
  providers: [
    {
      provide: AI_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): AiProvider => {
        const logger = new Logger('AiModule');
        const provider = config.get('AI_PROVIDER', { infer: true }) ?? 'groq';

        if (provider === 'groq') {
          if (!config.get('GROQ_API_KEY', { infer: true })) {
            return new NullAiProvider();
          }

          const groq = new GroqProvider(config);

          logger.log(
            `AI provider: Groq — text "${config.get('GROQ_MODEL', { infer: true })}", ` +
              (groq.supportsVision
                ? `vision "${config.get('GROQ_VISION_MODEL', { infer: true })}"`
                : 'vision disabled (OCR of scans will be skipped)'),
          );

          return groq;
        }

        if (provider === 'xai') {
          if (!config.get('XAI_API_KEY', { infer: true })) {
            return new NullAiProvider();
          }

          logger.log(`AI provider: xAI — "${config.get('XAI_MODEL', { infer: true })}"`);

          return new XaiProvider(config);
        }

        /**
         * `anthropic` and `openai` remain in the env enum because CLAUDE.md
         * originally specified Anthropic and the slots predate this module.
         * Neither is implemented — falling back loudly is honest, where
         * silently doing nothing would leave someone convinced Claude was
         * reading their documents.
         */
        logger.warn(
          `AI_PROVIDER is "${provider}", which has no implementation. Using the stub provider. ` +
            'Set AI_PROVIDER=groq with a GROQ_API_KEY to run real analysis.',
        );

        return new NullAiProvider();
      },
    },
  ],
  exports: [AI_PROVIDER],
})
export class AiModule {}
