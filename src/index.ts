//// filepath: /d:/Projects/TypeScript Projects/Websockets/src/index.ts
import dotenv from 'dotenv';
import { prisma } from './lib/prisma';
import { WebSocketServer, WebSocket } from 'ws';

interface ExtWebSocket extends WebSocket {
  email?: string;
}

dotenv.config();
const wss = new WebSocketServer({ port: 8080 });

const activeUsers: any = [];


const userHintDeductions: { [email: string]: { [questionId: number]: number } } = {};

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
      socket.send('Invalid message format. Please ensure JSON keys are double-quoted.');
      return;
    }
    const { command, email, answer } = msg;
    try {
      if (command === 'connect') {
        if (!email) {
          socket.send('Missing email parameter');
          return;
        }
        let user;
        try {
          user = await prisma.user.findUnique({ where: { email } });
        } catch (err) {
          console.error('Error finding user:', err);
          socket.send('Error finding user');
          return;
        }
        if (user) {
          socket.email = email;
          activeUsers.push(user);
          let leaderboardData, questionData;
          try {
            leaderboardData = await leaderboard();
            questionData = await questionDetails(Number(user.questionsAnswered) + 1);
          } catch (err) {
            console.error('Error fetching leaderboard or question data:', err);
            socket.send('Error fetching data');
            return;
          }
          const data = { leaderboard: leaderboardData, question: questionData };
          socket.send(JSON.stringify(data, jsonReplacer));
          console.log(activeUsers);
        } else {
          socket.send('User not found');
        }
      } else if (command === 'answer') {
        if (!email) {
          socket.send('Missing email parameter');
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
            socket.send('Error fetching question');
            return;
          }
          if (question && question.answer === answer.answer) {
            const currentQId = Number(answer.id);
            // Calculate the reward points using any deduction factor applied via hints.
            const hintFactor =
              (userHintDeductions[email] && userHintDeductions[email][currentQId]) || 1.0;
            const rewardPoints = Math.floor(question.points * hintFactor);
            
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
              // Update the activeUsers array with the latest user data.
              const idx = activeUsers.findIndex((u: any) => u.email === email);
              if (idx !== -1) {
                activeUsers[idx] = { ...activeUsers[idx], ...updatedUser };
              }
            } catch (err) {
              console.error('Error updating user:', err);
              socket.send('Error updating user data');
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
              socket.send('Error updating question points');
              return;
            }
            
           
            let updatedQuestionData;
            try {
              updatedQuestionData = await questionDetails(currentQId);
            } catch (err) {
              console.error('Error fetching updated question details:', err);
              socket.send('Error fetching updated question details');
              return;
            }
            
            // Clear any stored hint deductions for this user for the current question.
            if (userHintDeductions[email]) {
              delete userHintDeductions[email][currentQId];
            }
            
            let leaderboardData, nextQuestionData;
            try {
              leaderboardData = await leaderboard();
              nextQuestionData = await questionDetails(Number(updatedUser.questionsAnswered) + 1);
            } catch (err) {
              console.error('Error fetching updated leaderboard or next question data:', err);
              socket.send('Error fetching updated data');
              return;
            }
            
            // Send updated leaderboard and next question details to the current user.
            socket.send(JSON.stringify({ leaderboard: leaderboardData, question: nextQuestionData }, jsonReplacer));
            
            // Broadcast updated leaderboard to all other connected clients.
            wss.clients.forEach((client: WebSocket) => {
              if (client !== socket && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ leaderboard: leaderboardData }, jsonReplacer));
              }
            });
            
            // Broadcast updated question details only to users who are on the same question.
            wss.clients.forEach((client: WebSocket) => {
              const extClient = client as ExtWebSocket;
              if (extClient.readyState === WebSocket.OPEN && extClient.email) {
                // Find the active user's record.
                const activeUser = activeUsers.find((u: any) => u.email === extClient.email);
                // User's current question is questionsAnswered + 1
                if (activeUser && Number(activeUser.questionsAnswered) + 1 === currentQId) {
                  client.send(JSON.stringify({ updatedQuestion: updatedQuestionData }, jsonReplacer));
                }
              }
            });
            
          } else {
            socket.send('Incorrect Answer');
          }
        } else {
          socket.send('User not found');
        }
      } else if (command === 'hint1' || command === 'hint2') {
        if (!email) {
          socket.send('Missing email parameter');
          return;
        }
        const user = activeUsers.find((u: any) => u.email === email);
        if (!user) {
          socket.send('User not found');
          return;
        }
        
        const currentQuestionId = Number(user.questionsAnswered) + 1;
        let question;
        try {
          question = await prisma.questions.findUnique({
            where: { questionId: currentQuestionId },
            select: {
              hint1: true,
              hint2: true
            }
          });
        } catch (err) {
          console.error('Error fetching question for hints:', err);
          socket.send('Error fetching question for hints');
          return;
        }
        if (!question) {
          socket.send('Question not found for hints');
          return;
        }
        if (!userHintDeductions[email]) {
          userHintDeductions[email] = {};
        }
        if (command === 'hint1') {
          if (!question.hint1.used) {
            try {
              question = await prisma.questions.update({
                where: { questionId: currentQuestionId },
                data: {
                  hint1: { used: true, hint: question.hint1.hint }
                },
                select: { hint1: true }
              });
            } catch (err) {
              console.error('Error updating hint1:', err);
              socket.send('Error using hint1');
              return;
            }
          }
          // Set deduction factor to 0.9 for hint1 (10% reduction)
          userHintDeductions[email][currentQuestionId] = 0.9;
          socket.send(JSON.stringify({ hint: question.hint1.hint }, jsonReplacer));
        } else if (command === 'hint2') {
          if (!question.hint1.used) {
            socket.send('You must use hint1 before using hint2');
            return;
          }
          if (!question.hint2.used) {
            try {
              question = await prisma.questions.update({
                where: { questionId: currentQuestionId },
                data: {
                  hint2: { used: true, hint: question.hint2.hint }
                },
                select: { hint2: true }
              });
            } catch (err) {
              console.error('Error updating hint2:', err);
              socket.send('Error using hint2');
              return;
            }
          }
          // Multiply current user's deduction factor by 0.8 for hint2 (further 20% reduction)
          const currentFactor = userHintDeductions[email][currentQuestionId] || 1.0;
          userHintDeductions[email][currentQuestionId] = currentFactor * 0.8;
          socket.send(JSON.stringify({ hint: question.hint2.hint }, jsonReplacer));
        }
      }
    } catch (err) {
      console.error('Unhandled error:', err);
      socket.send('An error occurred');
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

const questionDetails = async (questionId: number) => {
  try {
    const question = await prisma.questions.findUnique({
      where: { questionId },
      select: {
        imageUrl: true,
        points: true,
        questionId: true
      }
    });
    return question;
  } catch (err) {
    console.error('Error in questionDetails function:', err);
    throw err;
  }
};