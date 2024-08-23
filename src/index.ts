import { Probot } from "probot";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const openai = new OpenAI();

export default (app: Probot) => {
  app.on(
    ["pull_request.opened", "pull_request.synchronize"],
    async (context) => {
      const pullRequest = context.payload.pull_request;
      const repo = context.repo();

      console.log(`Handle pull request: ${pullRequest.title}`);

      /**
       * Delete all previous comments
       **/
      // Fetch all review comments
      const { data: comments } = await context.octokit.pulls.listReviewComments(
        {
          ...repo,
          pull_number: pullRequest.number,
        }
      );
      // Filter comments made by the bot
      const botComments = comments.filter(
        (comment) => comment.user?.login === "review-buddy-dev[bot]"
      );
      console.log("Deleting bot comments...", botComments.length);
      // Delete each bot comment
      for (const comment of botComments) {
        await context.octokit.pulls.deleteReviewComment({
          ...repo,
          comment_id: comment.id,
        });
      }

      // Fetch the pull request files
      const files = await context.octokit.pulls.listFiles({
        ...repo,
        pull_number: pullRequest.number,
      });

      // Analyze the changes (you'll implement your AI logic here)
      const aiReviewComments = await analyzeChanges(files.data);

      for (const comment of aiReviewComments) {
        await context.octokit.pulls.createReviewComment({
          owner: context.repo().owner,
          repo: context.repo().repo,
          pull_number: pullRequest.number,
          commit_id: context.payload.pull_request.head.sha,
          ...comment,
        });
      }
    }
  );
};

interface FileChange {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch?: string;
}

async function analyzeChanges(files: FileChange[]): Promise<
  {
    body: string;
    path: string;
    line: number;
  }[]
> {
  const comments = [];

  for (const file of files) {
    console.log(`Analyzing file: ${file.filename}`, file.patch);
    if (file.patch) {
      const aiSuggestions = await analyzePathWithAI(file.patch);
      if (!aiSuggestions?.length) {
        continue;
      }

      console.log(aiSuggestions);

      for (const suggestion of aiSuggestions) {
        if (!suggestion.message) {
          continue;
        }
        comments.push({
          path: file.filename,
          line: suggestion.line,
          body: suggestion.message,
        });
      }
    }
  }

  return comments;
}

const Comment = z.object({
  message: z.string().nullable(),
  line: z.number(),
});
const ReviewComments = z.object({
  suggestions: z.array(Comment),
});

async function analyzePathWithAI(patch: string): Promise<
  | {
      message: string | null;
      line: number;
    }[]
  | null
> {
  console.log("Analyzing patch with AI...", patch);

  const chatCompletion = await openai.beta.chat.completions.parse({
    messages: [
      {
        role: "user",
        content: `You are an AI code reviewer and you are given a patch of a file in a GitHub pull request.
          Please review the patch and provide review comments and line number for review comment.

          Guidelines for review comments:
          You can suggest improvements, point out issues, or provide feedback.
          While providing suggestion, it would be helpful if you can provide the code changes you want to see in the patch.
          You can return markdown formatted message.
          If you don't have any suggestion you can return message as null.

          Guidelines for line:
          Line is the line number in the file where the comment should be placed.
          The comment should be placed on the line where the code change is made.
          
          Here is the patch:
          ${patch}`,
      },
    ],
    model: "gpt-4o-mini",
    response_format: zodResponseFormat(ReviewComments, "reviewResponse"),
  });

  const message = chatCompletion.choices[0]?.message;

  if (message?.parsed) {
    return message?.parsed.suggestions;
  }

  return null;
}
