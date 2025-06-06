import dotenv from 'dotenv';
import { prisma } from './lib/prisma';
import { WebSocketServer, WebSocket } from 'ws';
import moment from "moment-timezone";

interface ExtWebSocket extends WebSocket {
  email?: string;
}

dotenv.config();
const PORT = parseInt(process.env.PORT || '8080', 10);
const wss = new WebSocketServer({ port: PORT });
const activeUsers: any[] = [];

const jsonReplacer = (key: string, value: any) =>
  typeof value === 'bigint' ? value.toString() : value;

wss.on('connection', (socket: ExtWebSocket) => {
  socket.on('message', async (message: string) => {
    let msg: any;
    try {
      msg = JSON.parse(message);
      console.log('Received message:', msg);
    } catch (error) {
      console.error('Error parsing message:', error, 'Original message:', message);
      socket.send(JSON.stringify({
        error: 'Invalid message format. Please ensure JSON keys are double-quoted.'
      }));
      return;
    }

    const { command, email, answer } = msg;
    try {
      if (command === 'connect') {
        if (!email) {
          socket.send(JSON.stringify({ error: 'Missing email parameter' }));
          return;
        }
        let user;
        try {
          user = await prisma.user.findUnique({ where: { email } });
        } catch (err) {
          console.error('Error finding user:', err);
          socket.send(JSON.stringify({ error: 'Error finding user' }));
          return;
        }
        if (user) {
          socket.email = email;
          activeUsers.push(user);
          let leaderboardData, questionData;
          try {
            leaderboardData = await leaderboard();
            questionData = await questionDetails(Number(user.questionsAnswered) + 1, email);
          } catch (err) {
            console.error('Error fetching leaderboard or question data:', err);
            socket.send(JSON.stringify({ error: 'Error fetching data' }));
            return;
          }
          const data = {
            leaderboard: leaderboardData,
            question: questionData,
            totalPoints: user.points
          };
          socket.send(JSON.stringify(data, jsonReplacer));
          console.log(activeUsers);
          wss.clients.forEach((client: WebSocket) => {
            if (client !== socket && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ leaderboard: leaderboardData }, jsonReplacer));
            }
          });
        } else {
          socket.send(JSON.stringify({ error: 'User not found' }));
        }
      } else if (command === 'answer') {
        const contestEnd = moment.tz("2025-04-06T16:00:00", "Asia/Kolkata").valueOf();
        if (moment().tz("Asia/Kolkata").valueOf() > contestEnd) {
          socket.send(JSON.stringify({ message: "The contest has ended" }));
          return;
        }
        if (!email) {
          socket.send(JSON.stringify({ error: 'Missing email parameter' }));
          return;
        }
        const user = activeUsers.find((u: any) => u.email === email);
        if (user) {
          let question;
          try {
            question = await prisma.questions.findUnique({
              where: { questionId: Number(answer.id) },
              select: {
                answer: true,
                points: true,
                questionId: true,
                originalpoints: true
              }
            });
          } catch (err) {
            console.error('Error fetching question:', err);
            socket.send(JSON.stringify({ error: 'Error fetching question' }));
            return;
          }
          if (question && question.answer === answer.answer) {
            const currentQId = Number(answer.id);
            let rewardPoints = question.points;
            const hintRecord = user.hintsData.find((record: any) => record.id === currentQId);
            if (hintRecord) {
              if (hintRecord.hint1) {
                rewardPoints -= Math.floor(question.points * 0.1);
              }
              if (hintRecord.hint2) {
                rewardPoints = Math.floor(rewardPoints * 0.8);
              }
            }
            let updatedUser;
            try {
              updatedUser = await prisma.user.update({
                where: { email: user.email },
                data: {
                  points: { increment: rewardPoints },
                  questionsAnswered: { increment: 1 },
                  questionAnsweredTime: { push: { questionId: currentQId, time: new Date() } }
                }
              });
              const idx = activeUsers.findIndex((u: any) => u.email === email);
              if (idx !== -1) {
                activeUsers[idx] = { ...activeUsers[idx], ...updatedUser };
              }
            } catch (err) {
              console.error('Error updating user:', err);
              socket.send(JSON.stringify({ error: 'Error updating user data' }));
              return;
            }

            const originalPoints = question.originalpoints ?? question.points;
            const minPoints = Math.floor(originalPoints / 2);
            const deduction = Math.floor(question.points * 0.05);
            let newGlobalPoints = question.points - deduction;
            if (newGlobalPoints < minPoints) {
              newGlobalPoints = minPoints;
            }
            try {
              await prisma.questions.update({
                where: { questionId: currentQId },
                data: { points: newGlobalPoints }
              });
            } catch (err) {
              console.error('Error updating question points:', err);
              socket.send(JSON.stringify({ error: 'Error updating question points' }));
              return;
            }

            let updatedQuestionData;
            try {
              updatedQuestionData = await questionDetails(currentQId, email, true); // for the answering user
            } catch (err) {
              console.error('Error fetching updated question details:', err);
              socket.send(JSON.stringify({ error: 'Error fetching updated question details' }));
              return;
            }

            let leaderboardData, nextQuestionData;
            try {
              leaderboardData = await leaderboard();
              nextQuestionData = await questionDetails(Number(updatedUser.questionsAnswered) + 1, email);
            } catch (err) {
              console.error('Error fetching updated leaderboard or next question data:', err);
              socket.send(JSON.stringify({ error: 'Error fetching updated data' }));
              return;
            }

            // Send correct answer response (including totalPoints) only to the current user
            socket.send(JSON.stringify({
              answerStatus: "correct",
              leaderboard: leaderboardData,
              question: nextQuestionData,
              totalPoints: updatedUser.points
            }, jsonReplacer));

            // Broadcast leaderboard update to all other clients (without totalPoints)
            wss.clients.forEach((client: WebSocket) => {
              if (client !== socket && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ leaderboard: leaderboardData }, jsonReplacer));
              }
            });

            // For each connected client, recalculate the next question based on their own hints data.
            for (const client of wss.clients) {
              const extClient = client as ExtWebSocket;
              if (extClient.readyState === WebSocket.OPEN && extClient.email) {
                const activeUser = activeUsers.find((u: any) => u.email === extClient.email);
                if (activeUser) {
                  const nextQId = Number(activeUser.questionsAnswered) + 1;
                  try {
                    const updatedQuestionForUser = await questionDetails(nextQId, extClient.email, false);
                    client.send(JSON.stringify({ updatedQuestion: updatedQuestionForUser }, jsonReplacer));
                  } catch (error) {
                    console.error("Error sending updated question detail for", extClient.email, error);
                  }
                }
              }
            }
          } else {
            socket.send(JSON.stringify({ answerStatus: "incorrect" }, jsonReplacer));
          }
        } else {
          socket.send(JSON.stringify({ error: 'User not found' }));
        }
      } else if (command === 'hint1' || command === 'hint2') {
        const contestEnd = moment.tz("2025-04-06T16:00:00", "Asia/Kolkata").valueOf();
        if (moment().tz("Asia/Kolkata").valueOf() > contestEnd) {
          socket.send(JSON.stringify({ message: "The contest has ended" }));
          return;
        }
        if (!email) {
          socket.send(JSON.stringify({ error: 'Missing email parameter' }));
          return;
        }
        const user = activeUsers.find((u: any) => u.email === email);
        if (!user) {
          socket.send(JSON.stringify({ error: 'User not found' }));
          return;
        }
        const currentQuestionId = Number(user.questionsAnswered) + 1;
        let question;
        try {
          question = await prisma.questions.findUnique({
            where: { questionId: currentQuestionId },
            select: {
              hint1: true,
              hint2: true,
              points: true,
              originalpoints: true,
              dec_factor: true,
              questionVisitData: true
            }
          });
        } catch (err) {
          console.error('Error fetching question for hints:', err);
          socket.send(JSON.stringify({ error: 'Error fetching question for hints' }));
          return;
        }
        if (!question) {
          socket.send(JSON.stringify({ error: 'Question not found for hints' }));
          return;
        }
        let visitRecord = null;
        if (Array.isArray(question.questionVisitData) && question.questionVisitData.length > 0) {
          visitRecord = question.questionVisitData[0];
        }
        if (!visitRecord || !(visitRecord as { visitTime: string }).visitTime) {
          socket.send(JSON.stringify({ error: 'Visit data missing for this question' }));
          return;
        }
        const visitTime = moment((visitRecord as { visitTime: string }).visitTime)
          .tz("Asia/Kolkata").valueOf();
        const currTime = moment().tz("Asia/Kolkata").valueOf();
        // Note: twoHours here is set to 2 * 60 * 1000 (2 minutes) for testing; update as needed.
        const twoHours = 2 * 60 *60* 1000;
        if (currTime - visitTime < twoHours) {
          const unlockTime = moment(visitTime + twoHours).tz("Asia/Kolkata");
          socket.send(JSON.stringify({ message: `Hints will unlock at ${unlockTime.format("LTS")}` }));
          return;
        }
        const hintRecord = user.hintsData.find((record: any) => record.id === currentQuestionId);
        if (command === 'hint1') {
          if (hintRecord && hintRecord.hint1) {
            socket.send(JSON.stringify({ hint1: question.hint1 }));
            return;
          }
          const deduction = Math.floor(question.points * 0.1);
          const newPoints = question.points - deduction;
          user.hintsData = user.hintsData.map((record: any) =>
            record.id === currentQuestionId ? { ...record, hint1: true } : record
          );
          try {
            await prisma.user.update({
              where: { email: user.email },
              data: { hintsData: user.hintsData }
            });
            socket.send(JSON.stringify({ hint1: question.hint1, points: newPoints }));
          } catch (err) {
            console.error('Error updating hint1:', err);
            socket.send(JSON.stringify({ error: 'Error using hint1' }));
            return;
          }
        } else if (command === 'hint2') {
          if (!hintRecord || !hintRecord.hint1) {
            socket.send(JSON.stringify({ error: 'You must use hint1 before using hint2' }));
            return;
          }
          if (hintRecord.hint2) {
            socket.send(JSON.stringify({ hint2: question.hint2 }));
            return;
          }
          const baseAfterHint1 = question.points - Math.floor(question.points * 0.1);
          const deduction = Math.floor(baseAfterHint1 * 0.2);
          const newPoints = baseAfterHint1 - deduction;
          user.hintsData = user.hintsData.map((record: any) =>
            record.id === currentQuestionId ? { ...record, hint2: true } : record
          );
          try {
            await prisma.user.update({
              where: { email: user.email },
              data: { hintsData: user.hintsData }
            });
            socket.send(JSON.stringify({ hint2: question.hint2, points: newPoints }));
          } catch (err) {
            console.error('Error updating hint2:', err);
            socket.send(JSON.stringify({ error: 'Error using hint2' }));
            return;
          }
        }
      }
    } catch (err) {
      console.error('Unhandled error:', err);
      socket.send(JSON.stringify({ error: 'An error occurred' }));
    }
  });
});

const leaderboard = async () => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { points: 'desc' }
    });
    const filteredUsers = users.filter((user: any) => user.name !== "GeeksforGeeks RGIPT Student Chapter");
    return filteredUsers.map((user: any, index: any) => ({
      name: user.name,
      points: user.points,
      rank: index + 1
    }));
  } catch (err) {
    console.error('Error in leaderboard function:', err);
    throw err;
  }
};

const questionDetails = async (
  questionId: number,
  email: string,
  global: boolean = false
) => {
  try {
    let question = await prisma.questions.findUnique({
      where: { questionId },
      select: {
        imageUrl: true,
        points: true,
        questionId: true,
        originalpoints: true,
        questionVisitData: true
      }
    });
    if (!question) {
      throw new Error('Question not found');
    }
    if (!global) {
      if (
        Array.isArray(question.questionVisitData) &&
        question.questionVisitData.length > 0 &&
        (question.questionVisitData[0] as { isVisited: boolean }).isVisited === false
      ) {
        const newVisitData = [{
          isVisited: true,
          visitTime: moment().tz("Asia/Kolkata").format("YYYY-MM-DDTHH:mm:ssZ")
        }];
        question = await prisma.questions.update({
          where: { questionId },
          data: { questionVisitData: newVisitData },
          select: {
            imageUrl: true,
            points: true,
            questionId: true,
            originalpoints: true,
            questionVisitData: true
          }
        });
      }
    }
    if (global) {
      return question;
    } else {
      const userRecord = await prisma.user.findUnique({
        where: { email },
        select: { hintsData: true }
      });
      if (!userRecord) {
        throw new Error('User not found');
      }
      const hintsArray = userRecord.hintsData as Array<{ id: number; hint1: boolean; hint2: boolean }>;
      const hintRecord = hintsArray.find(record => record.id === questionId);
      let points = question.points;
      if (hintRecord) {
        if (hintRecord.hint1) {
          points -= Math.floor(question.points * 0.1);
        }
        if (hintRecord.hint2) {
          points = Math.floor(points * 0.8);
        }
      }
      return { ...question, points };
    }
  } catch (err) {
    console.error('Error in questionDetails function:', err);
    throw err;
  }
};