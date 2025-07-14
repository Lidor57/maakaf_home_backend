import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpService } from "@nestjs/axios";
import { lastValueFrom } from "rxjs";
import { CommitsService } from "./commits/commits.service";
import { PullRequestsService } from "./pull-requests/pull-requests.service";
import { IssuesService } from "./issues/issues.service";
import { CommentsService } from "./comments/comments.service";
import { UserProfilesService } from "./user-profiles/user-profiles.service";
import { IncrementalSyncService } from "./incremental-sync.service";
import { AppConfigService } from "../config/app-config.service";

@Injectable()
export class GithubActivityService {
  private readonly GITHUB_API_URL = "https://api.github.com/graphql";
  private readonly logger = new Logger(GithubActivityService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly commitsService: CommitsService,
    private readonly pullRequestsService: PullRequestsService,
    private readonly issuesService: IssuesService,
    private readonly commentsService: CommentsService,
    private readonly userProfilesService: UserProfilesService,
    private readonly incrementalSyncService: IncrementalSyncService,
    private readonly appConfig: AppConfigService
  ) {}

  async getUserActivity(usernames: string[]) {
    const token = this.configService.get<string>("GITHUB_TOKEN");
    this.logger.debug(`GitHub token configured: ${token ? 'Yes' : 'No'}`);
    this.logger.debug(`Token length: ${token?.length || 0}`);
    const results = [];

    for (const username of usernames) {
      try {
        // Fetch user profile data first
        const userProfile = await this.fetchUserProfile(username, token);
        
        const repos = await this.fetchUserRepos(username, token);
        const qualifyingRepos = [];
        for (const repo of repos) {
          try {
            if (repo.forkCount <= this.appConfig.minForkCount) continue;
            const activityLast6Months = await this.getRepoUserActivity(
              repo,
              username,
              token
            );
            // Only include repos with activity in the last 6 months
            if (
              activityLast6Months.commits === 0 &&
              activityLast6Months.pullRequests === 0 &&
              activityLast6Months.issues === 0 &&
              activityLast6Months.prComments === 0 &&
              activityLast6Months.issueComments === 0
            ) {
              continue;
            }
            qualifyingRepos.push({
              repoName: repo.name,
              description: repo.description,
              url: repo.url,
              ...activityLast6Months,
            });
          } catch (repoErr) {
            this.logger.warn(
              `Error processing repo ${repo.name} for user ${username}: ${repoErr.message}`
            );
          }
        }

        const summary = qualifyingRepos.reduce(
          (acc, repo) => ({
            totalCommits: acc.totalCommits + repo.commits,
            totalPRs: acc.totalPRs + repo.pullRequests,
            totalIssues: acc.totalIssues + repo.issues,
            totalPRComments: acc.totalPRComments + repo.prComments,
            totalIssueComments: acc.totalIssueComments + repo.issueComments,
          }),
          {
            totalCommits: 0,
            totalPRs: 0,
            totalIssues: 0,
            totalPRComments: 0,
            totalIssueComments: 0,
          }
        );
        
        results.push({
          user: {
            username: userProfile.username,
            displayName: userProfile.displayName,
            avatarUrl: userProfile.avatarUrl,
            bio: userProfile.bio,
            location: userProfile.location,
            company: userProfile.company,
            blog: userProfile.blog,
            twitterUsername: userProfile.twitterUsername,
            publicRepos: userProfile.publicRepos,
            followers: userProfile.followers,
            following: userProfile.following,
            accountType: userProfile.accountType,
            createdAt: userProfile.createdAt,
          },
          repos: qualifyingRepos,
          summary,
        });
      } catch (userErr) {
        this.logger.error(
          `Error processing user ${username}: ${userErr.message}`
        );
        results.push({
          user: { username, error: userErr.message },
          repos: [],
          summary: null,
        });
      }
    }

    // Calculate global summary across all users
    const globalSummary = results.reduce(
      (acc, userResult) => {
        if (userResult.summary) {
          acc.totalCommits += userResult.summary.totalCommits;
          acc.totalPRs += userResult.summary.totalPRs;
          acc.totalIssues += userResult.summary.totalIssues;
          acc.totalPRComments += userResult.summary.totalPRComments;
          acc.totalIssueComments += userResult.summary.totalIssueComments;
          acc.totalRepos += userResult.repos.length;
          acc.successfulUsers += 1;
        } else {
          acc.failedUsers += 1;
        }
        return acc;
      },
      {
        totalCommits: 0,
        totalPRs: 0,
        totalIssues: 0,
        totalPRComments: 0,
        totalIssueComments: 0,
        totalRepos: 0,
        successfulUsers: 0,
        failedUsers: 0,
        totalUsers: usernames.length,
        analysisTimeframe: `${this.appConfig.analysisStartDate.toISOString().split('T')[0]} to ${new Date().toISOString().split('T')[0]}`,
        minForkCountFilter: this.appConfig.minForkCount,
      }
    );

    return {
      users: results,
      globalSummary
    };
  }

  private async fetchUserRepos(username: string, token: string) {
    const query = `
      query($login: String!, $after: String) {
        user(login: $login) {
          repositories(first: 100, privacy: PUBLIC, after: $after) {
            nodes {
              name
              description
              url
              isFork
              isArchived
              owner { login }
              stargazerCount
              forkCount
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `;
    let repos = [];
    let after = null;
    try {
      while (true) {
        const variables = { login: username, after };
        const data = await this.graphqlRequest(query, variables, token);
        const nodes = data.user?.repositories?.nodes || [];
        repos = repos.concat(
          nodes.map((repo: any) => ({
            name: repo.name,
            description: repo.description,
            url: repo.url,
            isFork: repo.isFork,
            isArchived: repo.isArchived,
            owner: repo.owner.login,
            stargazerCount: repo.stargazerCount,
            forkCount: repo.forkCount,
          }))
        );
        if (!data.user?.repositories?.pageInfo?.hasNextPage) break;
        after = data.user.repositories.pageInfo.endCursor;
      }
    } catch (err) {
      this.logger.error(
        `Error fetching repos for user ${username}: ${err.message}`
      );
      throw err;
    }
    return repos;
  }

  private async getRepoUserActivity(
    repo: any,
    username: string,
    token: string
  ) {
    const repoFullName = `${repo.owner}/${repo.name}`;
    
    // Use incremental sync if enabled
    if (this.appConfig.enableIncrementalSync) {
      this.logger.debug(`Using incremental sync for ${username} in ${repoFullName}`);
      const result = await this.incrementalSyncService.syncUserRepoActivity(username, repo, token);
      return {
        commits: result.commits,
        pullRequests: result.pullRequests,
        issues: result.issues,
        prComments: result.prComments,
        issueComments: result.issueComments,
      };
    }
    
    // Fallback to original caching logic
    const sixMonthsAgo = this.appConfig.analysisStartDate;
    
    this.logger.debug(`Using original caching for ${username} in ${repoFullName}`);
    
    // Check cached data for all activity types
    const [
      cachedCommitCount,
      cachedPRCount,
      cachedIssueCount,
      cachedPRCommentCount,
      cachedIssueCommentCount
    ] = await Promise.all([
      this.commitsService.getCommitCount(username, repoFullName, sixMonthsAgo),
      this.pullRequestsService.getPRCount(username, repoFullName, sixMonthsAgo),
      this.issuesService.getIssueCount(username, repoFullName, sixMonthsAgo),
      this.commentsService.getCommentCount(username, repoFullName, 'PR', sixMonthsAgo),
      this.commentsService.getCommentCount(username, repoFullName, 'ISSUE', sixMonthsAgo)
    ]);
    
    // If we have any cached data, use it (optimization: assume if one type is cached, all are)
    const totalCachedActivity = cachedCommitCount + cachedPRCount + cachedIssueCount + 
                               cachedPRCommentCount + cachedIssueCommentCount;
    
    if (totalCachedActivity > 0) {
      this.logger.debug(`Using cached data for ${username} in ${repoFullName}`);
      return {
        commits: cachedCommitCount,
        pullRequests: cachedPRCount,
        issues: cachedIssueCount,
        prComments: cachedPRCommentCount,
        issueComments: cachedIssueCommentCount,
      };
    }
    
    // No cached data found, fetch from GitHub API
    this.logger.debug(`No cached data found for ${username} in ${repoFullName}, fetching from GitHub API`);
    
    return await this.fetchAndCacheRepoActivity(repo, username, token);
  }

  private async fetchAndCacheRepoActivity(repo: any, username: string, token: string) {
    const repoFullName = `${repo.owner}/${repo.name}`;
    const sixMonthsAgo = this.appConfig.analysisStartDate;
    
    const query = `
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            target {
              ... on Commit {
                history(first: 100) {
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
          issues(first: 100, states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: DESC}) {
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
    
    const variables = { owner: repo.owner, name: repo.name };
    
    try {
      const data = await this.graphqlRequest(query, variables, token);
      
      // Process commits
      const commits = data.repository?.defaultBranchRef?.target?.history?.nodes || [];
      const userCommits = commits.filter((commit: any) => 
        commit.author?.user?.login === username
      );
      
      const commitsToStore = userCommits.map((commit: any) => ({
        repo: repoFullName,
        repoOwner: repo.owner,
        sha: commit.oid,
        committedDate: new Date(commit.committedDate),
        author: username,
        message: commit.message,
        rawData: commit,
        fetchedAt: new Date()
      }));

      // Process Pull Requests
      const pullRequests = data.repository?.pullRequests?.nodes || [];
      const userPRs = pullRequests.filter((pr: any) => pr.author?.login === username);
      
      const prsToStore = userPRs.map((pr: any) => ({
        repo: repoFullName,
        repoOwner: repo.owner,
        prNumber: pr.number,
        author: username,
        title: pr.title,
        state: pr.state,
        createdAt: new Date(pr.createdAt),
        closedAt: pr.closedAt ? new Date(pr.closedAt) : undefined,
        mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : undefined,
        rawData: pr,
        fetchedAt: new Date()
      }));

      // Process Issues
      const issues = data.repository?.issues?.nodes || [];
      const userIssues = issues.filter((issue: any) => issue.author?.login === username);
      
      const issuesToStore = userIssues.map((issue: any) => ({
        repo: repoFullName,
        repoOwner: repo.owner,
        issueNumber: issue.number,
        author: username,
        title: issue.title,
        state: issue.state,
        createdAt: new Date(issue.createdAt),
        closedAt: issue.closedAt ? new Date(issue.closedAt) : undefined,
        rawData: issue,
        fetchedAt: new Date()
      }));

      // Process Comments (PR and Issue comments)
      const allComments = [];
      
      // PR Comments
      pullRequests.forEach((pr: any) => {
        const prComments = pr.comments?.nodes || [];
        prComments.forEach((comment: any) => {
          if (comment.author?.login === username) {
            allComments.push({
              repo: repoFullName,
              repoOwner: repo.owner,
              commentId: comment.id,
              author: username,
              type: 'PR',
              parentNumber: pr.number,
              createdAt: new Date(comment.createdAt),
              body: comment.body,
              rawData: comment,
              fetchedAt: new Date()
            });
          }
        });
      });
      
      // Issue Comments
      issues.forEach((issue: any) => {
        const issueComments = issue.comments?.nodes || [];
        issueComments.forEach((comment: any) => {
          if (comment.author?.login === username) {
            allComments.push({
              repo: repoFullName,
              repoOwner: repo.owner,
              commentId: comment.id,
              author: username,
              type: 'ISSUE',
              parentNumber: issue.number,
              createdAt: new Date(comment.createdAt),
              body: comment.body,
              rawData: comment,
              fetchedAt: new Date()
            });
          }
        });
      });

      // Store all data in parallel
      await Promise.all([
        commitsToStore.length > 0 ? this.commitsService.bulkUpsert(commitsToStore) : Promise.resolve(),
        prsToStore.length > 0 ? this.pullRequestsService.bulkUpsert(prsToStore) : Promise.resolve(),
        issuesToStore.length > 0 ? this.issuesService.bulkUpsert(issuesToStore) : Promise.resolve(),
        allComments.length > 0 ? this.commentsService.bulkUpsert(allComments) : Promise.resolve()
      ]);

      // Count activity from the last 6 months
      const commitCount = userCommits.filter((commit: any) =>
        new Date(commit.committedDate).getTime() >= sixMonthsAgo.getTime()
      ).length;

      const prCount = userPRs.filter((pr: any) =>
        new Date(pr.createdAt).getTime() >= sixMonthsAgo.getTime()
      ).length;

      const issueCount = userIssues.filter((issue: any) =>
        new Date(issue.createdAt).getTime() >= sixMonthsAgo.getTime()
      ).length;

      const prCommentCount = allComments.filter((comment: any) =>
        comment.type === 'PR' && new Date(comment.createdAt).getTime() >= sixMonthsAgo.getTime()
      ).length;

      const issueCommentCount = allComments.filter((comment: any) =>
        comment.type === 'ISSUE' && new Date(comment.createdAt).getTime() >= sixMonthsAgo.getTime()
      ).length;

      this.logger.debug(`Cached ${commitsToStore.length} commits, ${prsToStore.length} PRs, ${issuesToStore.length} issues, ${allComments.length} comments for ${username} in ${repoFullName}`);

      return {
        commits: commitCount,
        pullRequests: prCount,
        issues: issueCount,
        prComments: prCommentCount,
        issueComments: issueCommentCount,
      };
      
    } catch (err) {
      this.logger.error(
        `Error fetching and caching activity for repo ${repo.name} and user ${username}: ${err.message}`
      );
      throw err;
    }
  }

  private async fetchUserProfile(username: string, token: string) {
    this.logger.debug(`Fetching profile for user: ${username}`);
    
    // Check if we have cached profile data
    const cachedProfile = await this.userProfilesService.findByUsername(username);
    const isProfileCacheValid = cachedProfile && 
      await this.userProfilesService.isProfileCacheValid(username, this.appConfig.cacheExpiryDate);
    
    if (isProfileCacheValid) {
      this.logger.debug(`Using cached profile for user: ${username}`);
      return cachedProfile;
    }
    
    // Fetch fresh profile data from GitHub
    this.logger.debug(`Fetching fresh profile data for user: ${username}`);
    
    const query = `
      query($login: String!) {
        user(login: $login) {
          login
          name
          bio
          avatarUrl
          location
          company
          websiteUrl
          twitterUsername
          publicRepos: repositories(privacy: PUBLIC) { totalCount }
          followers { totalCount }
          following { totalCount }
          createdAt
          __typename
        }
      }
    `;
    
    try {
      const data = await this.graphqlRequest(query, { login: username }, token);
      const user = data.user;
      
      if (!user) {
        throw new Error(`User ${username} not found`);
      }
      
      const profileData = {
        username: user.login,
        displayName: user.name,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        location: user.location,
        company: user.company,
        blog: user.websiteUrl, // GitHub uses websiteUrl instead of blog
        twitterUsername: user.twitterUsername,
        email: null, // Email requires additional scopes, setting to null
        publicRepos: user.publicRepos.totalCount,
        followers: user.followers.totalCount,
        following: user.following.totalCount,
        accountType: user.__typename, // 'User' or 'Organization'
        createdAt: new Date(user.createdAt),
        rawData: user,
      };
      
      // Store/update the profile data
      const savedProfile = await this.userProfilesService.upsert(profileData);
      this.logger.debug(`Cached profile data for user: ${username}`);
      
      return savedProfile;
    } catch (err) {
      this.logger.error(`Error fetching profile for user ${username}: ${err.message}`);
      // If we have any cached data, return it as fallback
      if (cachedProfile) {
        this.logger.debug(`Using stale cached profile for user: ${username}`);
        return cachedProfile;
      }
      throw err;
    }
  }

  private async graphqlRequest(query: string, variables: any, token: string) {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    try {
      const response$ = this.httpService.post(
        this.GITHUB_API_URL,
        { query, variables },
        { headers }
      );
      const response = await lastValueFrom(response$);
      if (response.data.errors) {
        this.logger.error(
          `GitHub GraphQL error: ${JSON.stringify(response.data.errors, null, 2)}`
        );
        this.logger.error(`Query: ${query}`);
        this.logger.error(`Variables: ${JSON.stringify(variables)}`);
        throw new Error(`GitHub GraphQL error: ${response.data.errors[0]?.message || 'Unknown error'}`);
      }
      return response.data.data;
    } catch (err) {
      this.logger.error(`GraphQL request failed: ${err.message}`);
      if (err.response) {
        this.logger.error(`Response status: ${err.response.status}`);
        this.logger.error(`Response data: ${JSON.stringify(err.response.data, null, 2)}`);
      }
      throw err;
    }
  }
}
