import { IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApprovalStatus } from '@prisma/client';

export class RequestApprovalDto {
  /**
   * Who should decide. Omitted means "anyone who can approve" — a small company
   * should not have to invent a routing policy to use the feature.
   */
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class DecideApprovalDto {
  /**
   * Only the two terminal decisions. CANCELLED exists on the enum but is
   * reached by the requester withdrawing, not by a decider — accepting it here
   * would let an approver silently retract someone else's request.
   */
  @IsIn([ApprovalStatus.APPROVED, ApprovalStatus.REJECTED])
  decision!: typeof ApprovalStatus.APPROVED | typeof ApprovalStatus.REJECTED;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ListApprovalsDto {
  @IsOptional()
  @IsEnum(ApprovalStatus)
  status?: ApprovalStatus;

  /** 'me' narrows to requests assigned to the caller or left open to anyone. */
  @IsOptional()
  @IsIn(['me', 'mine'])
  scope?: 'me' | 'mine';

  @IsOptional()
  @IsUUID()
  cursor?: string;
}
