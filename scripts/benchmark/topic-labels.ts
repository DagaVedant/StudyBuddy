export interface TopicLabel {
  prompt: string
  accept: string[]
  assigned?: string
}

const COMBINATORICS = [
  'competition-math.counting-and-probability.permutations-and-combinations',
  'competition-math.counting-and-probability.fundamental-counting-principle',
]

export const TOPIC_LABELS: TopicLabel[] = [
  {
    prompt:
      'In how many ways can 6 people be seated around a circular table if two specific people must sit next to each other?',
    accept: COMBINATORICS,
    assigned: 'sat-math.geometry-and-trigonometry',
  },
  {
    prompt:
      'A 6-foot-tall person casts a shadow 4 feet long at the same moment a nearby flagpole casts a shadow 20 feet long. Using similar triangles, how tall is the flagpole?',
    accept: [
      'competition-math.geometry.similarity-and-congruence',
      'competition-math.geometry.similarity-and-congruence',
      'competition-math.geometry.similarity-and-congruence',
    ],
    assigned: 'competition-math.geometry.quadrilaterals-and-polygons',
  },
  {
    prompt:
      'A team of 4 is to be chosen from a group of 10 students, but one particular student must be included on the team. How many different teams are possible?',
    accept: COMBINATORICS,
    assigned: 'competition-math.ratio-proportion-and-percent.percent-of-a-number',
  },
  {
    prompt: 'Three times a number, decreased by 4, equals 29. What is the number?',
    accept: [
      'competition-math.algebra.linear-equations',
      'competition-math.algebra.linear-equations',
      'sat-math.algebra.linear-equations-in-one-variable',
    ],
    assigned: 'competition-math.number-theory.factors-and-multiples',
  },
  {
    prompt: 'The sum of a number and twice that number is 51. What is the number?',
    accept: [
      'competition-math.algebra.linear-equations',
      'competition-math.algebra.linear-equations',
      'competition-math.algebra.linear-equations',
      'sat-math.algebra.linear-equations-in-one-variable',
    ],
    assigned: 'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  },
  {
    prompt:
      "A cube-shaped water tank's volume increases from 125 cubic feet to 1,000 cubic feet after an upgrade. By what factor does the side length of the tank increase?",
    accept: [
      'competition-math.arithmetic-and-number-sense.squares-cubes-and-roots',
      'competition-math.geometry.similarity-and-congruence',
    ],
    assigned: 'competition-math.geometry.solids-surface-area-and-volume',
  },
  {
    prompt: 'What is the value of 8 × 9 − 7 × 6 + 5 × 4 − 3 × 2 + 1?',
    accept: ['competition-math.arithmetic-and-number-sense.order-of-operations'],
    assigned: 'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  },
  {
    prompt: 'If today is Wednesday, what day of the week will it be 100 days from today?',
    accept: ['competition-math.number-theory.remainders-and-modular-arithmetic'],
    assigned: 'sat-math.geometry-and-trigonometry',
  },
  {
    prompt:
      'A machine is calibrated on a Wednesday. Its next full service is scheduled for exactly 100 days later. On what day of the week is the service?',
    accept: ['competition-math.number-theory.remainders-and-modular-arithmetic'],
    assigned: 'competition-math.algebra.systems-of-equations',
  },
  {
    prompt:
      'A palindrome is a number that reads the same forwards and backwards, such as 373. How many three-digit palindromes are there?',
    accept: COMBINATORICS,
    assigned: 'competition-math.number-theory.factors-and-multiples',
  },
  {
    prompt:
      'How many 3-digit even numbers can be formed using the digits 1, 2, 3, 4, and 5, with no digit repeated?',
    accept: COMBINATORICS,
    assigned: 'competition-math.number-theory.factors-and-multiples',
  },
  {
    prompt:
      "A club with 8 members wants to choose a committee of 3 people, where the order of selection doesn't matter. How many different committees are possible?",
    accept: COMBINATORICS,
    assigned: 'competition-math.counting-and-probability.probability-of-an-event',
  },
  {
    prompt:
      "A pizza shop offers 7 toppings. How many different 3-topping pizzas can be made, assuming no topping is repeated and order doesn't matter?",
    accept: COMBINATORICS,
    assigned: 'competition-math.counting-and-probability.probability-of-an-event',
  },
  {
    prompt:
      'At a party, every person shakes hands with every other person exactly once. If there are 12 people at the party, how many total handshakes occur?',
    accept: COMBINATORICS,
    assigned: 'competition-math.counting-and-probability.probability-of-an-event',
  },
  {
    prompt: 'The sum of four consecutive odd integers is 96. What is the largest of these integers?',
    accept: [
      'competition-math.algebra.linear-equations',
      'competition-math.algebra.word-problems-into-equations',
      'competition-math.algebra.sequences-and-series',
    ],
  },
  {
    prompt:
      'Two positive numbers differ by 4. Their product is 96. What is the sum of the two numbers?',
    accept: [
      'competition-math.algebra.word-problems-into-equations',
      'competition-math.algebra.quadratics-and-factoring',
    ],
  },
  {
    prompt:
      'A delivery drone flies in a straight line from a warehouse at (1, 2) to a customer at (7, 10), where coordinates are measured in kilometers. What distance does the drone travel?',
    accept: [
      'competition-math.geometry.coordinate-geometry',
      'competition-math.geometry.right-triangles-and-the-pythagorean-theorem',
    ],
    assigned: 'competition-math.geometry.angles-lines-and-segments',
  },
  {
    prompt:
      'Bike Path A has a slope of 3/4 as it crosses a park. Bike Path B is being designed to intersect Path A at a right angle. What is the slope of Bike Path B?',
    accept: [
      'competition-math.algebra.slope-intercepts-and-linear-graphs',
      'competition-math.geometry.angles-lines-and-segments',
    ],
    assigned: 'sat-math.geometry-and-trigonometry',
  },
  {
    prompt:
      'The solution of (2 x + 1) ÷ 3 = x − 1 is equal to the slope of the line through (1, 4) and (3, y). What is the value of y?',
    accept: [
      'competition-math.algebra.slope-intercepts-and-linear-graphs',
      'competition-math.algebra.linear-equations',
    ],
    assigned: 'competition-math.algebra.slope-intercepts-and-linear-graphs',
  },
  {
    prompt:
      'A price is increased by 20% and then decreased by 20%. What is the net percent change from the original price?',
    accept: [
      'competition-math.ratio-proportion-and-percent.successive-percent-change',
      'competition-math.ratio-proportion-and-percent.percent-increase-and-decrease',
    ],
  },
  {
    prompt:
      'A jacket originally priced $80 is discounted 25%, and then the sale price is discounted an additional 10%. What is the final price?',
    accept: [
      'competition-math.ratio-proportion-and-percent.successive-percent-change',
      'competition-math.ratio-proportion-and-percent.discount-markup-and-tax',
    ],
  },
  {
    prompt: 'If 30% of a number is 45, what is the number?',
    accept: [
      'competition-math.ratio-proportion-and-percent.working-backwards-from-a-percent',
      'competition-math.ratio-proportion-and-percent.percent-of-a-number',
    ],
  },
  {
    prompt:
      "A city's sales tax rate is 8%. What is the total cost, including tax, of an item priced at $45.00?",
    accept: [
      'competition-math.ratio-proportion-and-percent.discount-markup-and-tax',
    ],
  },
  {
    prompt:
      'A video game character starts at position E(1, 5). The character is first moved 3 units left and 2 units down, and then the entire screen is flipped over the x-axis. What is the character\'s final position?',
    accept: [
      'competition-math.geometry.transformations',
      'competition-math.geometry.transformations',
    ],
  },
  {
    prompt:
      "A clock hand's tip is at point F(5, -2) relative to the center of the clock. As the hand moves, it rotates 90° clockwise about the origin. What are the coordinates of the tip after this rotation?",
    accept: ['competition-math.geometry.transformations'],
  },
  {
    prompt:
      'A graphic designer has a shape with a vertex at G(6, -1). To create a diagonal-symmetric version, the vertex is reflected over the line y = x. What are the coordinates of the reflected vertex?',
    accept: ['competition-math.geometry.transformations'],
  },
  {
    prompt:
      'Two parallel lines are cut by a transversal, and one of the angles measures 65 degrees. What is the measure of its co-interior angle?',
    accept: [
      'competition-math.geometry.angles-lines-and-segments',
      'competition-math.geometry.angles-lines-and-segments',
    ],
  },
  {
    prompt: 'What value of x satisfies 4(2x − 3) − 5 = 3(x + 4) + 2?',
    accept: [
      'competition-math.algebra.linear-equations',
      'competition-math.algebra.linear-equations',
    ],
    assigned: 'competition-math.algebra.systems-of-equations',
  },
  {
    prompt: 'What value of x satisfies 3x − 7 = 20?',
    accept: [
      'competition-math.algebra.linear-equations',
      'sat-math.algebra.linear-equations-in-one-variable',
    ],
  },
]
