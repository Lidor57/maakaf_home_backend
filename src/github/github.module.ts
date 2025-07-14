import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MongooseModule } from '@nestjs/mongoose';
import { GithubController } from './github.controller';
import { GithubActivityService } from './github-activity.service';
import { CommitsModule } from './commits/commits.module';
import { PullRequestsModule } from './pull-requests/pull-requests.module';
import { IssuesModule } from './issues/issues.module';
import { CommentsModule } from './comments/comments.module';
import { UserProfilesModule } from './user-profiles/user-profiles.module';
import { AppConfigService } from '../config/app-config.service';
import { SyncMetadata, SyncMetadataSchema } from './sync-metadata.schema';
import { SyncMetadataService } from './sync-metadata.service';
import { IncrementalSyncService } from './incremental-sync.service';

@Module({
  imports: [
    HttpModule, 
    CommitsModule, 
    PullRequestsModule, 
    IssuesModule, 
    CommentsModule,
    UserProfilesModule,
    MongooseModule.forFeature([
      { name: SyncMetadata.name, schema: SyncMetadataSchema }
    ])
  ],
  controllers: [GithubController],
  providers: [
    GithubActivityService, 
    AppConfigService, 
    SyncMetadataService,
    IncrementalSyncService
  ],
  exports: [GithubActivityService, IncrementalSyncService],
})
export class GithubModule {}
