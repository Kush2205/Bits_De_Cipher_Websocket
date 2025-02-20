import dotenv from 'dotenv';
import { prisma } from './lib/prisma';
import { WebSocketServer, WebSocket } from 'ws';

interface ExtWebSocket extends WebSocket {
  email?: string;
}

dotenv.config();
const PORT = parseInt(process.env.PORT || '8080', 10);
const wss = new WebSocketServer({ port: PORT });

const activeUsers: any = [];

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
      socket.send(JSON.stringify({ error: 'Invalid message format. Please ensure JSON keys are double-quoted.' }));
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
          const data = { leaderboard: leaderboardData, question: questionData };
          socket.send(JSON.stringify(data, jsonReplacer));
          console.log(activeUsers);
        } else {
          socket.send(JSON.stringify({ error: 'User not found' }));
        }
      } else if (command === 'answer') {
        if (!email) {
          socket.send(JSON.stringify({ error: 'Missing email parameter' }));
          return;
        }
        const user = activeUsers.find((u: any) => u.email === email);
        if (user) {
          let question;
          try {
            question = await prisma.questions.findUnique({
              where: { questionId: Number(answer.id) }
            });
          } catch (err) {
            console.error('Error fetching question:', err);
            socket.send(JSON.stringify({ error: 'Error fetching question' }));
            return;
          }
          if (question && question.answer === answer.answer) {
            const currentQId = Number(answer.id);
            let rewardPoints = question.points;

            const hintsData = user.hintsData as Array<{ id: number; hint1: boolean; hint2: boolean }>;
            const hintIndex = hintsData.findIndex(hint => hint.id === currentQId);

            if (hintIndex !== -1) {
              if (hintsData[hintIndex].hint1) {
                rewardPoints -= Math.floor(question.points * 0.1);
              }
              if (hintsData[hintIndex].hint2) {
                rewardPoints -= Math.floor(rewardPoints * 0.2);
              }
            }

            let updatedUser;
            try {
              updatedUser = await prisma.user.update({
                where: { email: user.email },
                data: {
                  points: { increment: rewardPoints },
                  questionsAnswered: { increment: 1 },
                  questionAnsweredTime: {
                    push: { questionId: currentQId, time: new Date() }
                  }
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
            let newGlobalPoints = question.points - Math.floor(originalPoints * question.dec_factor);
            console.log('New global points:', newGlobalPoints);
            const minPoints = Math.floor(originalPoints / 2);
            if (newGlobalPoints < minPoints) newGlobalPoints = minPoints;
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
              updatedQuestionData = await questionDetails(currentQId, email);
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

            socket.send(JSON.stringify({ answerStatus: "correct", leaderboard: leaderboardData, question: nextQuestionData }, jsonReplacer));

            wss.clients.forEach((client: WebSocket) => {
              if (client !== socket && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ leaderboard: leaderboardData }, jsonReplacer));
              }
            });

            wss.clients.forEach((client: WebSocket) => {
              const extClient = client as ExtWebSocket;
              if (extClient.readyState === WebSocket.OPEN && extClient.email) {
                const activeUser = activeUsers.find((u: any) => u.email === extClient.email);
                if (activeUser && Number(activeUser.questionsAnswered) + 1 === currentQId) {
                  client.send(JSON.stringify({ updatedQuestion: updatedQuestionData }, jsonReplacer));
                }
              }
            });

          } else {
            socket.send(JSON.stringify({ answerStatus: "incorrect" }, jsonReplacer));
          }
        } else {
          socket.send(JSON.stringify({ error: 'User not found' }));
        }
      } else if (command === 'hint1' || command === 'hint2') {
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
              dec_factor: true
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

        const hintsData = user.hintsData as Array<{ id: number; hint1: boolean; hint2: boolean }>;
        const hintIndex = hintsData.findIndex(hint => hint.id === currentQuestionId);

        if (hintIndex === -1) {
          socket.send(JSON.stringify({ error: 'Question not found in hintsData' }));
          return;
        }

        if (command === 'hint1') {
          if (hintsData[hintIndex].hint1) {
            socket.send(JSON.stringify({ hint1: question.hint1 }, jsonReplacer));
            return;
          }

          const deduction = Math.floor(question.points * 0.1);
          const newPoints = question.points - deduction;

          try {
            hintsData[hintIndex].hint1 = true;

            await prisma.user.update({
              where: { email: user.email },
              data: { hintsData, }
            });

            socket.send(JSON.stringify({ hint1: question.hint1, points: newPoints }, jsonReplacer));
          } catch (err) {
            console.error('Error updating hint1:', err);
            socket.send(JSON.stringify({ error: 'Error using hint1' }));
            return;
          }
        } else if (command === 'hint2') {
          if (!hintsData[hintIndex].hint1) {
            socket.send(JSON.stringify({ error: 'You must use hint1 before using hint2' }));
            return;
          }

          if (hintsData[hintIndex].hint2) {
            socket.send(JSON.stringify({ hint2: question.hint2 }, jsonReplacer));
            return;
          }

          const deduction = Math.floor(question.points *0.9* 0.2);
          const newPoints = question.points*0.9 - deduction;

          try {
            hintsData[hintIndex].hint2 = true;

            await prisma.user.update({
              where: { email: user.email },
              data: { hintsData,}
            });

            socket.send(JSON.stringify({ hint2: question.hint2, points: newPoints }, jsonReplacer));
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
    return users.map((user, index) => ({
      name: user.name,
      points: user.points,
      rank: index + 1
    }));
  } catch (err) {
    console.error('Error in leaderboard function:', err);
    throw err;
  }
};

const questionDetails = async (questionId: number, email: string) => {
  try {
    const question = await prisma.questions.findUnique({
      where: { questionId },
      select: {
        imageUrl: true,
        points: true,
        questionId: true
      }
    });

    if (!question) {
      throw new Error('Question not found');
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        hintsData: true
      }
    });

    if (!user) {
      throw new Error('User not found');
    }

    const hintsData = user.hintsData as Array<{ id: number; hint1: boolean; hint2: boolean }>;
    const hintIndex = hintsData.findIndex(hint => hint.id === questionId);

    let points = question.points;

    if (hintIndex !== -1) {
      if (hintsData[hintIndex].hint1) {
        points -= Math.floor(question.points * 0.1);
      }
      if (hintsData[hintIndex].hint2) {
        points -= Math.floor(points * 0.2);
      }
    }

    return {
      ...question,
      points
    };
  } catch (err) {
    console.error('Error in questionDetails function:', err);
    throw err;
  }
};