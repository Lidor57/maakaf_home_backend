import { Injectable, Logger } from '@nestjs/common';
import { CommitsService } from './commits/commits.service';
import { PullRequestsService } from './pull-requests/pull-requests.service';
import { IssuesService } from './issues/issues.service';
import { CommentsService } from './comments/comments.service';
import { UserProfilesService } from './user-profiles/user-profiles.service';
import { SyncMetadataService } from './sync-metadata.service';
import { AppConfigService } from '../config/app-config.service';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

interface LastSyncMetadata {
  username: string;
  repo: string;
  lastSyncDate: Date;
  lastCommitSha?: string;
  lastPRNumber?: number;
  lastIssueNumber?: number;
  totalItems: {
    commits: number;
    pullRequests: number;
    issues: number;
    prComments: number;
    issueComments: number;
  };
}

@Injectable()
export class IncrementalSyncService {
  private readonly logger = new Logger(IncrementalSyncService.name);
  private readonly GITHUB_API_URL = 'https://api.github.com/graphql';

  constructor(
    private readonly httpService: HttpService,
    private readonly commitsService: CommitsService,
    private readonly pullRequestsService: PullRequestsService,
    private readonly issuesService: IssuesService,
    private readonly commentsService: CommentsService,
    private readonly userProfilesService: UserProfilesService,
    private readonly syncMetadataService: SyncMetadataService,
    private readonly appConfig: AppConfigService
  ) {}

  /**
   * Performs incremental sync for a user's repository activity
   * Only fetches new data since the last sync
   */
  async syncUserRepoActivity(
    username: string,
    repo: any,
    token: string
  ): Promise<{
    commits: number;
    pullRequests: number;
    issues: number;
    prComments: number;
    issueComments: number;
    isIncremental: boolean;
    itemsFetched: number;
  }> {
    const repoFullName = `${repo.owner}/${repo.name}`;
    
    // Get last sync metadata
    const lastSync = await this.syncMetadataService.findByUsernameAndRepo(username, repoFullName);
    
    if (!lastSync) {
      // First time sync - fetch all data
      this.logger.debug(`First sync for ${username} in ${repoFullName}`);
      return await this.performFullSync(username, repo, token);
    }
    
    // Check if cache is still valid
    const cacheAge = Date.now() - lastSync.lastSyncDate.getTime();
    const cacheValidityMs = this.appConfig.incrementalSyncIntervalHours * 60 * 60 * 1000;
    
    if (cacheAge < cacheValidityMs) {
      this.logger.debug(`Cache still valid for ${username} in ${repoFullName}`);
      return {
        ...lastSync.totalItems,
        isIncremental: false,
        itemsFetched: 0
      };
    }
    
    // Perform incremental sync
    this.logger.debug(`Performing incremental sync for ${username} in ${repoFullName}`);
    return await this.performIncrementalSync(username, repo, token, lastSync);
  }

  private async performFullSync(username: string, repo: any, token: string) {
    const repoFullName = `${repo.owner}/${repo.name}`;
    const sixMonthsAgo = this.appConfig.analysisStartDate;
    
    const query = `
      query($owner: String!, $name: String!, $since: GitTimestamp!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            target {
              ... on Commit {
                history(first: ${this.appConfig.maxCommitsPerRepo}, since: $since) {
                  nodes {
                    oid
                    author { user { login } }
                    committedDate
                    message
                  }
                }
              }
            }
          }
          pullRequests(first: ${this.appConfig.maxPRsPerRepo}, states: [OPEN, CLOSED, MERGED], orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes { 
              number
              title
              state
              createdAt
              closedAt
              mergedAt
              author { login }
              comments(first: 100) {
                nodes {
                  id
                  body
                  createdAt
                  author { login }
                }
              }
            }
          }
          issues(first: ${this.appConfig.maxIssuesPerRepo}, states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes { 
              number
              title
              state
              createdAt
              closedAt
              author { login }
              comments(first: 100) {
                nodes {
                  id
                  body
                  createdAt
                  author { login }
                }
              }
            }
          }
        }
      }
    `;
    
    const variables = {
      owner: repo.owner,
      name: repo.name,
      since: sixMonthsAgo.toISOString()
    };
    
    const data = await this.graphqlRequest(query, variables, token);
    const repository = data.repository;
    
    if (!repository) {
      throw new Error(`Repository ${repoFullName} not found`);
    }
    
    // Process and cache all data
    const results = await this.processAndCacheFullData(
      username,
      repoFullName,
      repository,
      sixMonthsAgo
    );
    
    // Save sync metadata
    await this.syncMetadataService.upsert({
      username,
      repo: repoFullName,
      lastSyncDate: new Date(),
      lastCommitSha: repository.defaultBranchRef?.target?.history?.nodes?.[0]?.oid,
      lastPRNumber: Math.max(...(repository.pullRequests?.nodes?.map(pr => pr.number) || [0])),
      lastIssueNumber: Math.max(...(repository.issues?.nodes?.map(issue => issue.number) || [0])),
      totalItems: results
    });
    
    return {
      ...results,
      isIncremental: false,
      itemsFetched: Object.values(results).reduce((sum, count) => sum + count, 0)
    };
  }

  private async performIncrementalSync(
    username: string,
    repo: any,
    token: string,
    lastSync: LastSyncMetadata
  ) {
    const repoFullName = `${repo.owner}/${repo.name}`;
    
    // Query for new data since last sync
    const query = `
      query($owner: String!, $name: String!, $since: GitTimestamp!, $lastPRNumber: Int!, $lastIssueNumber: Int!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            target {
              ... on Commit {
                history(first: 100, since: $since) {
                  nodes {
                    oid
                    author { user { login } }
                    committedDate
                    message
                  }
                }
              }
            }
          }
          pullRequests(first: 50, states: [OPEN, CLOSED, MERGED], orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes { 
              number
              title
              state
              createdAt
              closedAt
              mergedAt
              author { login }
              comments(first: 100) {
                nodes {
                  id
                  body
                  createdAt
                  author { login }
                }
              }
            }
          }
          issues(first: 50, states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes { 
              number
              title
              state
              createdAt
              closedAt
              author { login }
              comments(first: 100) {
                nodes {
                  id
                  body
                  createdAt
                  author { login }
                }
              }
            }
          }
        }
      }
    `;
    
    const variables = {
      owner: repo.owner,
      name: repo.name,
      since: lastSync.lastSyncDate.toISOString(),
      lastPRNumber: lastSync.lastPRNumber || 0,
      lastIssueNumber: lastSync.lastIssueNumber || 0
    };
    
    const data = await this.graphqlRequest(query, variables, token);
    const repository = data.repository;
    
    if (!repository) {
      throw new Error(`Repository ${repoFullName} not found`);
    }
    
    // Filter for truly new items
    const newCommits = repository.defaultBranchRef?.target?.history?.nodes?.filter(
      commit => !lastSync.lastCommitSha || commit.oid !== lastSync.lastCommitSha
    ) || [];
    
    const newPRs = repository.pullRequests?.nodes?.filter(
      pr => pr.number > (lastSync.lastPRNumber || 0)
    ) || [];
    
    const newIssues = repository.issues?.nodes?.filter(
      issue => issue.number > (lastSync.lastIssueNumber || 0)
    ) || [];
    
    // Process and cache only new data
    const newResults = await this.processAndCacheIncrementalData(
      username,
      repoFullName,
      { commits: newCommits, pullRequests: newPRs, issues: newIssues },
      lastSync.lastSyncDate
    );
    
    // Update totals
    const updatedTotals = {
      commits: lastSync.totalItems.commits + newResults.commits,
      pullRequests: lastSync.totalItems.pullRequests + newResults.pullRequests,
      issues: lastSync.totalItems.issues + newResults.issues,
      prComments: lastSync.totalItems.prComments + newResults.prComments,
      issueComments: lastSync.totalItems.issueComments + newResults.issueComments
    };
    
    // Update sync metadata
    await this.syncMetadataService.upsert({
      username,
      repo: repoFullName,
      lastSyncDate: new Date(),
      lastCommitSha: newCommits[0]?.oid || lastSync.lastCommitSha,
      lastPRNumber: Math.max(...newPRs.map(pr => pr.number), lastSync.lastPRNumber || 0),
      lastIssueNumber: Math.max(...newIssues.map(issue => issue.number), lastSync.lastIssueNumber || 0),
      totalItems: updatedTotals
    });
    
    return {
      ...updatedTotals,
      isIncremental: true,
      itemsFetched: Object.values(newResults).reduce((sum, count) => sum + count, 0)
    };
  }

  private async processAndCacheFullData(
    username: string,
    repoFullName: string,
    repository: any,
    sixMonthsAgo: Date
  ) {
    // Process commits
    const commits = repository.defaultBranchRef?.target?.history?.nodes || [];
    const userCommits = commits.filter(commit => 
      commit.author?.user?.login === username &&
      new Date(commit.committedDate) >= sixMonthsAgo
    );
    
    // Process PRs
    const pullRequests = repository.pullRequests?.nodes || [];
    const userPRs = pullRequests.filter(pr => 
      pr.author?.login === username &&
      new Date(pr.createdAt) >= sixMonthsAgo
    );
    
    // Process Issues
    const issues = repository.issues?.nodes || [];
    const userIssues = issues.filter(issue => 
      issue.author?.login === username &&
      new Date(issue.createdAt) >= sixMonthsAgo
    );
    
    // Process Comments
    let userPRComments = 0;
    let userIssueComments = 0;
    
    // PR Comments
    pullRequests.forEach(pr => {
      const comments = pr.comments?.nodes || [];
      userPRComments += comments.filter(comment => 
        comment.author?.login === username &&
        new Date(comment.createdAt) >= sixMonthsAgo
      ).length;
    });
    
    // Issue Comments
    issues.forEach(issue => {
      const comments = issue.comments?.nodes || [];
      userIssueComments += comments.filter(comment => 
        comment.author?.login === username &&
        new Date(comment.createdAt) >= sixMonthsAgo
      ).length;
    });
    
    // Cache the data
    await this.cacheDataToMongoDB(username, repoFullName, {
      commits: userCommits,
      pullRequests: userPRs,
      issues: userIssues,
      prComments: userPRComments,
      issueComments: userIssueComments
    });
    
    return {
      commits: userCommits.length,
      pullRequests: userPRs.length,
      issues: userIssues.length,
      prComments: userPRComments,
      issueComments: userIssueComments
    };
  }

  private async processAndCacheIncrementalData(
    username: string,
    repoFullName: string,
    newData: any,
    lastSyncDate: Date
  ) {
    // Process only new commits
    const userCommits = newData.commits.filter(commit => 
      commit.author?.user?.login === username &&
      new Date(commit.committedDate) > lastSyncDate
    );
    
    // Process only new PRs
    const userPRs = newData.pullRequests.filter(pr => 
      pr.author?.login === username &&
      new Date(pr.createdAt) > lastSyncDate
    );
    
    // Process only new Issues
    const userIssues = newData.issues.filter(issue => 
      issue.author?.login === username &&
      new Date(issue.createdAt) > lastSyncDate
    );
    
    // Process only new Comments
    let userPRComments = 0;
    let userIssueComments = 0;
    
    // New PR Comments
    newData.pullRequests.forEach(pr => {
      const comments = pr.comments?.nodes || [];
      userPRComments += comments.filter(comment => 
        comment.author?.login === username &&
        new Date(comment.createdAt) > lastSyncDate
      ).length;
    });
    
    // New Issue Comments
    newData.issues.forEach(issue => {
      const comments = issue.comments?.nodes || [];
      userIssueComments += comments.filter(comment => 
        comment.author?.login === username &&
        new Date(comment.createdAt) > lastSyncDate
      ).length;
    });
    
    // Cache only the new data
    await this.cacheDataToMongoDB(username, repoFullName, {
      commits: userCommits,
      pullRequests: userPRs,
      issues: userIssues,
      prComments: userPRComments,
      issueComments: userIssueComments
    });
    
    return {
      commits: userCommits.length,
      pullRequests: userPRs.length,
      issues: userIssues.length,
      prComments: userPRComments,
      issueComments: userIssueComments
    };
  }

  private async cacheDataToMongoDB(username: string, repoFullName: string, data: any) {
    const promises = [];
    
    // Cache commits
    if (data.commits.length > 0) {
      const commitData = data.commits.map(commit => ({
        repo: repoFullName,
        repoOwner: repoFullName.split('/')[0],
        sha: commit.oid,
        author: username,
        message: commit.message,
        committedDate: new Date(commit.committedDate),
        rawData: commit,
        fetchedAt: new Date()
      }));
      promises.push(this.commitsService.bulkUpsert(commitData));
    }
    
    // Cache PRs
    if (data.pullRequests.length > 0) {
      const prData = data.pullRequests.map(pr => ({
        repo: repoFullName,
        repoOwner: repoFullName.split('/')[0],
        prNumber: pr.number,
        title: pr.title,
        state: pr.state,
        author: username,
        createdAt: new Date(pr.createdAt),
        closedAt: pr.closedAt ? new Date(pr.closedAt) : null,
        mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
        rawData: pr,
        fetchedAt: new Date()
      }));
      promises.push(this.pullRequestsService.bulkUpsert(prData));
    }
    
    // Cache Issues
    if (data.issues.length > 0) {
      const issueData = data.issues.map(issue => ({
        repo: repoFullName,
        repoOwner: repoFullName.split('/')[0],
        issueNumber: issue.number,
        title: issue.title,
        state: issue.state,
        author: username,
        createdAt: new Date(issue.createdAt),
        closedAt: issue.closedAt ? new Date(issue.closedAt) : null,
        rawData: issue,
        fetchedAt: new Date()
      }));
      promises.push(this.issuesService.bulkUpsert(issueData));
    }
    
    await Promise.all(promises);
  }

  private async graphqlRequest(query: string, variables: any, token: string) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    
    const response$ = this.httpService.post(
      this.GITHUB_API_URL,
      { query, variables },
      { headers }
    );
    
    const response = await lastValueFrom(response$);
    
    if (response.data.errors) {
      throw new Error(`GitHub GraphQL error: ${response.data.errors[0]?.message || 'Unknown error'}`);
    }
    
    return response.data.data;
  }
}
