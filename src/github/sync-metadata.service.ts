import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SyncMetadata } from './sync-metadata.schema';

@Injectable()
export class SyncMetadataService {
  constructor(
    @InjectModel(SyncMetadata.name) private syncMetadataModel: Model<SyncMetadata>
  ) {}

  async findByUsernameAndRepo(username: string, repo: string): Promise<SyncMetadata | null> {
    return this.syncMetadataModel.findOne({ username, repo }).exec();
  }

  async upsert(syncData: Partial<SyncMetadata>): Promise<SyncMetadata> {
    return this.syncMetadataModel.findOneAndUpdate(
      { username: syncData.username, repo: syncData.repo },
      { $set: { ...syncData, fetchedAt: new Date() } },
      { upsert: true, new: true }
    ).exec();
  }

  async isIncrementalSyncValid(username: string, repo: string, expiryDate: Date): Promise<boolean> {
    const metadata = await this.syncMetadataModel.findOne({ 
      username, 
      repo,
      lastSyncDate: { $gte: expiryDate } 
    }).exec();
    
    return !!metadata;
  }

  async isFullSyncRequired(username: string, repo: string, fullSyncExpiryDate: Date): Promise<boolean> {
    const metadata = await this.syncMetadataModel.findOne({ 
      username, 
      repo,
      lastSyncDate: { $lt: fullSyncExpiryDate } 
    }).exec();
    
    return !!metadata;
  }

  async updateTotalItems(
    username: string, 
    repo: string, 
    totalItems: {
      commits: number;
      pullRequests: number;
      issues: number;
      prComments: number;
      issueComments: number;
    }
  ): Promise<void> {
    await this.syncMetadataModel.updateOne(
      { username, repo },
      { $set: { totalItems, lastSyncDate: new Date() } }
    ).exec();
  }

  async incrementTotalItems(
    username: string, 
    repo: string, 
    incrementalItems: {
      commits: number;
      pullRequests: number;
      issues: number;
      prComments: number;
      issueComments: number;
    }
  ): Promise<void> {
    await this.syncMetadataModel.updateOne(
      { username, repo },
      { 
        $inc: { 
          'totalItems.commits': incrementalItems.commits,
          'totalItems.pullRequests': incrementalItems.pullRequests,
          'totalItems.issues': incrementalItems.issues,
          'totalItems.prComments': incrementalItems.prComments,
          'totalItems.issueComments': incrementalItems.issueComments
        },
        $set: { lastSyncDate: new Date() }
      }
    ).exec();
  }

  async deleteByUsernameAndRepo(username: string, repo: string): Promise<void> {
    await this.syncMetadataModel.deleteOne({ username, repo }).exec();
  }

  async findAllByUsername(username: string): Promise<SyncMetadata[]> {
    return this.syncMetadataModel.find({ username }).exec();
  }

  async cleanup(olderThan: Date): Promise<void> {
    await this.syncMetadataModel.deleteMany({ 
      lastSyncDate: { $lt: olderThan } 
    }).exec();
  }
}
