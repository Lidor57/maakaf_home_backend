import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class SyncMetadata extends Document {
  @Prop({ required: true })
  username: string;

  @Prop({ required: true })
  repo: string;

  @Prop({ required: true })
  lastSyncDate: Date;

  @Prop()
  lastCommitSha?: string;

  @Prop()
  lastPRNumber?: number;

  @Prop()
  lastIssueNumber?: number;

  @Prop({
    type: {
      commits: { type: Number, default: 0 },
      pullRequests: { type: Number, default: 0 },
      issues: { type: Number, default: 0 },
      prComments: { type: Number, default: 0 },
      issueComments: { type: Number, default: 0 }
    },
    default: {
      commits: 0,
      pullRequests: 0,
      issues: 0,
      prComments: 0,
      issueComments: 0
    }
  })
  totalItems: {
    commits: number;
    pullRequests: number;
    issues: number;
    prComments: number;
    issueComments: number;
  };

  @Prop({ default: Date.now })
  fetchedAt: Date;
}

export const SyncMetadataSchema = SchemaFactory.createForClass(SyncMetadata);

// Create compound index for efficient queries
SyncMetadataSchema.index({ username: 1, repo: 1 }, { unique: true });
